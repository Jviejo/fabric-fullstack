import { connect, ConnectOptions, Identity, Signer, signers } from '@hyperledger/fabric-gateway';
import "reflect-metadata";

import * as grpc from '@grpc/grpc-js';
import * as crypto from 'crypto';
import { User } from 'fabric-common';
import { promises as fs } from 'fs';
import * as _ from "lodash";
import { AddressInfo } from "net";
import { Logger } from "tslog";
import * as yaml from "yaml";
import { checkConfig, config } from './config';
import FabricCAServices = require("fabric-ca-client")
import express = require("express")

const log = new Logger({ name: "products-api" })

export async function newGrpcConnection(peerEndpoint: string, tlsRootCert: Buffer): Promise<grpc.Client> {
    const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
    return new grpc.Client(peerEndpoint, tlsCredentials, {});
}

export async function newConnectOptions(
    client: grpc.Client,
    mspId: string,
    credentials: Uint8Array,
    privateKeyPem: string
): Promise<ConnectOptions> {
    return {
        client,
        identity: await newIdentity(mspId, credentials),
        signer: await newSigner(privateKeyPem),
        // Default timeouts for different gRPC calls
        evaluateOptions: () => {
            return { deadline: Date.now() + 5000 }; // 5 seconds
        },
        endorseOptions: () => {
            return { deadline: Date.now() + 15000 }; // 15 seconds
        },
        submitOptions: () => {
            return { deadline: Date.now() + 5000 }; // 5 seconds
        },
        commitStatusOptions: () => {
            return { deadline: Date.now() + 60000 }; // 1 minute
        },
    };
}

async function newIdentity(mspId: string, credentials: Uint8Array): Promise<Identity> {

    return { mspId, credentials };
}

async function newSigner(privateKeyPem: string): Promise<Signer> {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    return signers.newPrivateKeySigner(privateKey);
}


async function main() {
    checkConfig()
    const networkConfig = yaml.parse(await fs.readFile(config.networkConfigPath, 'utf8'));
    const orgPeerNames = _.get(networkConfig, `organizations.${config.mspID}.peers`)
    let peerUrl: string = "";
    let peerCACert: string = "";
    let idx = 0
    for (const peerName of orgPeerNames) {
        const peer = networkConfig.peers[peerName]
        const peerUrlKey = `url`
        const peerCACertKey = `tlsCACerts.pem`
        peerUrl = _.get(peer, peerUrlKey).replace("grpcs://", "")
        peerCACert = _.get(peer, peerCACertKey)
        idx++;
        if (idx >= 1) {
            break;
        }
    }
    const ca = networkConfig.certificateAuthorities[config.caName]
    if (!ca) {
        throw new Error(`Certificate authority ${config.caName} not found in network configuration`);
    }
    const caURL = ca.url;
    if (!caURL) {
        throw new Error(`Certificate authority ${config.caName} does not have a URL`);
    }
    const fabricCAServices = new FabricCAServices(caURL, {
        trustedRoots: [],
        verify: false,
    }, "ca")

    const identityService = fabricCAServices.newIdentityService()
    const registrarUserResponse = await fabricCAServices.enroll({
        enrollmentID: ca.registrar.enrollId,
        enrollmentSecret: ca.registrar.enrollSecret
    });

    const registrar = User.createUser(
        ca.registrar.enrollId,
        ca.registrar.enrollSecret,
        config.mspID,
        registrarUserResponse.certificate,
        registrarUserResponse.key.toBytes()
    );


    const adminUser = _.get(networkConfig, `organizations.${config.mspID}.users.${config.hlfUser}`)
    const userCertificate = _.get(adminUser, "cert.pem")
    const userKey = _.get(adminUser, "key.pem")

    const grpcConn = await newGrpcConnection(peerUrl, Buffer.from(peerCACert))
    const connectOptions = await newConnectOptions(
        grpcConn,
        config.mspID,
        Buffer.from(userCertificate),
        userKey
    )
    const gateway = connect(connectOptions);
    const network = gateway.getNetwork(config.channelName);
    const contract = network.getContract(config.chaincodeName);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        next();
    })
    const tokenName = "CDC"
    const tokenSymbol = "$"
    try {
        const initialized = await contract.submitTransaction("Initialize", tokenName, tokenSymbol)
        log.info("Initialized: ", initialized.toString())
    } catch (e) {
        log.info("Already initialized")
    }
    app.post("/init", async (req, res) => {
        try {
            const initialized = await contract.submitTransaction("Initialize", tokenName, tokenSymbol)
            log.info("Initialized: ", initialized.toString())
        } catch (e) {
            log.info("Already initialized")
        }
        res.send("Initialized")
    })
    const users = {}
    app.post("/signup", async (req, res) => {
        const { username, password } = req.body
        let identityFound = null
        try {
            identityFound = await identityService.getOne(username, registrar)
        } catch (e) {
            log.info("Identity not found, registering", e)
        }
        if (identityFound) {
            res.status(400)
            res.send("Username already taken")
            return
        }
        const r = await fabricCAServices.register({
            enrollmentID: username,
            enrollmentSecret: password,
            affiliation: "",
            role: "client",
            attrs: [],
            maxEnrollments: -1
        }, registrar)
        res.send("OK")
    })
    app.post("/login", async (req, res) => {
        const { username, password } = req.body
        let identityFound = null
        try {
            identityFound = await identityService.getOne(username, registrar)
        } catch (e) {
            log.info("Identity not found, registering", e)
            res.status(400)
            res.send("Username not found")
            return
        }
        const r = await fabricCAServices.enroll({
            enrollmentID: username,
            enrollmentSecret: password,
        })
        users[username] = r
        res.send("OK")
    })
    app.use(async (req, res, next) => {
        (req as any).contract = contract
        try {
            const user = req.headers["x-user"] as string
            console.log(users, user)
            if (user && users[user]) {
                const connectOptions = await newConnectOptions(
                    grpcConn,
                    config.mspID,
                    Buffer.from(users[user].certificate),
                    users[user].key.toBytes()
                )
                const gateway = connect(connectOptions);
                const network = gateway.getNetwork(config.channelName);
                const contract = network.getContract(config.chaincodeName);
                (req as any).contract = contract
            }
            next()
        } catch (e) {
            log.error(e)
            next(e)
        }
    })

    app.get("/ping", async (req, res) => {
        try {
            const responseBuffer = await (req as any).contract.evaluateTransaction("Ping");
            const responseString = Buffer.from(responseBuffer).toString();
            res.send(responseString);
        } catch (e) {
            res.status(400)
            res.send(e.message);
        }
    })

    app.post("/evaluate", async (req, res) => {
        try {
            const fcn = req.body.fcn
            const responseBuffer = await (req as any).contract.evaluateTransaction(fcn, ...(req.body.args || []));
            const responseString = Buffer.from(responseBuffer).toString();
            res.send(responseString);
        } catch (e) {
            res.status(400)
            res.send(e.details && e.details.length ? e.details : e.message);
        }
    })

    app.post("/submit", async (req, res) => {
        try {
            const fcn = req.body.fcn
            const responseBuffer = await (req as any).contract.submitTransaction(fcn, ...(req.body.args || []));
            const responseString = Buffer.from(responseBuffer).toString();
            res.send(responseString);
        } catch (e) {
            res.status(400)
            res.send(e.details && e.details.length ? e.details : e.message);
        }
    })
    const server = app.listen(
        {
            port: process.env.PORT || 3004,
            host: process.env.HOST || "0.0.0.0",
        },
        () => {
            const addressInfo: AddressInfo = server.address() as AddressInfo;
            console.log(`
        Server is running!
        Listening on ${addressInfo.address}:${addressInfo.port}
      `);
        }
    );

}


main()
