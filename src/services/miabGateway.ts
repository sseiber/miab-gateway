import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import { IIotCentralPluginModule } from '../plugins/iotCentralModule';
import { IBlobStoragePluginModuleOptions } from 'src/plugins/blobStorage';
import { HealthState } from './health';
import {
    arch as osArch,
    hostname as osHostname,
    platform as osPlatform,
    type as osType,
    release as osRelease,
    version as osVersion,
    cpus as osCpus,
    totalmem as osTotalMem,
    freemem as osFreeMem,
    loadavg as osLoadAvg
} from 'os';
import { resolve as resolvePath } from 'path';
import {
    gzipSync,
    gunzipSync
} from 'zlib';
import * as Wreck from '@hapi/wreck';
import { bind, sleep, fileStream } from '../utils';
import {
    OpcEndpoint,
    emptyOpcCredential,
    IBrowseNodesRequestParams,
    IReadNodesRequestParams,
    IWriteNodesRequestParams
} from './miabModels';
import moment = require('moment');

const ModuleName = 'MiabGatewayService';

const IotcOutputName = 'iotc';
const defaultHealthCheckRetries = 3;

interface IModuleEnvironmentConfig {
    ompAdapterModuleId: string;
    dpsProvisioningHost: string;
}

interface ISystemProperties {
    cpuModel: string;
    cpuCores: number;
    cpuUsage: number;
    totalMemory: number;
    freeMemory: number;
}

enum IotcEdgeHostDevicePropNames {
    Hostname = 'hostname',
    ProcessorArchitecture = 'processorArchitecture',
    Platform = 'platform',
    OsType = 'osType',
    OsName = 'osName',
    TotalMemory = 'totalMemory',
    SwVersion = 'swVersion'
}

enum IoTCentralClientState {
    Disconnected = 'disconnected',
    Connected = 'connected'
}

enum ModuleState {
    Inactive = 'inactive',
    Active = 'active'
}

interface IRestartGatewayModuleCommandRequestParams {
    timeout: number;
}

interface IModuleCommandResponse {
    status: number;
    message: string;
    payload?: any;
}

export enum MiabGatewayCapability {
    tlSystemHeartbeat = 'tlSystemHeartbeat',
    tlFreeMemory = 'tlFreeMemory',
    stIoTCentralClientState = 'stIoTCentralClientState',
    stModuleState = 'stModuleState',
    evModuleStarted = 'evModuleStarted',
    evModuleStopped = 'evModuleStopped',
    evModuleRestart = 'evModuleRestart',
    evFetchedOpcNodesStarted = 'evFetchedOpcNodesStarted',
    evFetchedOpcNodesFinished = 'evFetchedOpcNodesFinished',
    evFetchedOpcNodesUploaded = 'evFetchedOpcNodesUploaded',
    wpDebugTelemetry = 'wpDebugTelemetry',
    wpOpcEndpoint = 'wpOpcEndpoint',
    wpBlobConnectionString = 'wpBlobConnectionString',
    wpBlobContainerName = 'wpBlobContainerName',
    cmTestOpcEndpoint = 'cmTestOpcEndpoint',
    cmFetchOpcNodes = 'cmFetchOpcNodes',
    cmWriteOpcValues = 'cmWriteOpcValues',
    cmReadOpcValues = 'cmReadOpcValues',
    cmRestartGatewayModule = 'cmRestartGatewayModule'
}

interface IMiabGatewaySettings {
    [MiabGatewayCapability.wpDebugTelemetry]: boolean;
    [MiabGatewayCapability.wpOpcEndpoint]: OpcEndpoint;
    [MiabGatewayCapability.wpBlobConnectionString]: string;
    [MiabGatewayCapability.wpBlobContainerName]: string;
}

export interface IMiabGatewayUtility {
    moduleEnvironmentConfig: IModuleEnvironmentConfig;
    getModuleSetting(setting: string): any;
    iotcApiRequest(uri: string, method: string, options: any): Promise<any>;
}

@service('miabGateway')
export class MiabGatewayService implements IMiabGatewayUtility {
    @inject('$server')
    private server: Server;

    private iotCentralPluginModule: IIotCentralPluginModule;
    private healthCheckRetries: number = defaultHealthCheckRetries;
    private healthState = HealthState.Good;
    private healthCheckFailStreak = 0;
    private moduleSettings: IMiabGatewaySettings = {
        [MiabGatewayCapability.wpDebugTelemetry]: false,
        [MiabGatewayCapability.wpOpcEndpoint]: emptyOpcCredential,
        [MiabGatewayCapability.wpBlobConnectionString]: '',
        [MiabGatewayCapability.wpBlobContainerName]: ''
    };
    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], 'initialize');
    }

    @bind
    public async initializeModule(): Promise<void> {
        this.server.log([ModuleName, 'info'], `initializeModule`);

        this.iotCentralPluginModule = this.server.settings.app.iotCentral;
    }

    @bind
    public debugTelemetry(): boolean {
        return this.moduleSettings[MiabGatewayCapability.wpDebugTelemetry];
    }

    @bind
    public async onHandleModuleProperties(desiredChangedSettings: any): Promise<void> {
        try {
            this.server.log([ModuleName, 'info'], `onHandleModuleProperties`);
            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
            }

            const patchedProperties = {};

            for (const setting in desiredChangedSettings) {
                if (!Object.prototype.hasOwnProperty.call(desiredChangedSettings, setting)) {
                    continue;
                }

                if (setting === '$version') {
                    continue;
                }

                const value = desiredChangedSettings[setting];

                switch (setting) {
                    case MiabGatewayCapability.wpDebugTelemetry:
                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting] = value || false,
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case MiabGatewayCapability.wpOpcEndpoint:
                        this.moduleSettings[setting] = {
                            ...this.moduleSettings[setting],
                            ...(value || emptyOpcCredential)
                        };

                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting],
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    case MiabGatewayCapability.wpBlobConnectionString:
                    case MiabGatewayCapability.wpBlobContainerName:
                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting] = value || '',
                            ac: 200,
                            ad: 'completed',
                            av: desiredChangedSettings['$version']
                        };
                        break;

                    default:
                        this.server.log([ModuleName, 'error'], `Received desired property change for unknown setting '${setting}'`);
                        break;
                }
            }

            if (Object.prototype.hasOwnProperty.call(patchedProperties, 'value')) {
                await this.iotCentralPluginModule.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }
    }

    @bind
    public onModuleClientError(error: Error): void {
        this.server.log([ModuleName, 'error'], `Module client connection error: ${error.message}`);
        this.healthState = HealthState.Critical;
    }

    @bind
    public async onModuleReady(): Promise<void> {
        this.server.log([ModuleName, 'info'], `Starting onModuleReady initializaton`);

        this.healthCheckRetries = Number(process.env.healthCheckRetries) || defaultHealthCheckRetries;
        this.healthState = this.iotCentralPluginModule.moduleClient ? HealthState.Good : HealthState.Critical;

        const blobStorageOptions: IBlobStoragePluginModuleOptions = {
            blobConnectionString: this.moduleSettings[MiabGatewayCapability.wpBlobConnectionString],
            blobContainerName: this.moduleSettings[MiabGatewayCapability.wpBlobContainerName]
        };

        if (blobStorageOptions.blobConnectionString && blobStorageOptions.blobContainerName) {
            if (!(await this.server.settings.app.blobStorage.configureBlobStorageClient(blobStorageOptions))) {
                this.server.log([ModuleName, 'error'], `An error occurred while trying to configure the blob storage client`);
            }
        }
        else {
            this.server.log([ModuleName, 'info'], `All optional blob storage configuration values were not found`);
        }

        const systemProperties = await this.getSystemProperties();

        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmTestOpcEndpoint, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmFetchOpcNodes, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmWriteOpcValues, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmReadOpcValues, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmRestartGatewayModule, this.handleDirectMethod);

        await this.iotCentralPluginModule.updateModuleProperties({
            [IotcEdgeHostDevicePropNames.ProcessorArchitecture]: osArch() || 'Unknown',
            [IotcEdgeHostDevicePropNames.Hostname]: osHostname() || 'Unknown',
            [IotcEdgeHostDevicePropNames.Platform]: osPlatform() || 'Unknown',
            [IotcEdgeHostDevicePropNames.OsType]: osType() || 'Unknown',
            [IotcEdgeHostDevicePropNames.OsName]: osRelease() || 'Unknown',
            [IotcEdgeHostDevicePropNames.TotalMemory]: systemProperties.totalMemory || 0,
            [IotcEdgeHostDevicePropNames.SwVersion]: osVersion() || 'Unknown'
        });

        await this.iotCentralPluginModule.sendMeasurement({
            [MiabGatewayCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
            [MiabGatewayCapability.stModuleState]: ModuleState.Active,
            [MiabGatewayCapability.evModuleStarted]: 'Module initialization'
        }, IotcOutputName);
    }

    @bind
    public async getHealth(): Promise<HealthState> {
        if (!this.iotCentralPluginModule) {
            return this.healthState;
        }

        let healthState = this.healthState;

        try {
            if (healthState === HealthState.Good) {
                const healthTelemetry = {};
                const systemProperties = await this.getSystemProperties();
                const freeMemory = systemProperties?.freeMemory || 0;

                healthTelemetry[MiabGatewayCapability.tlFreeMemory] = freeMemory;

                // TODO:
                // Find the right threshold for this metric
                if (freeMemory === 0) {
                    healthState = HealthState.Critical;
                }

                healthTelemetry[MiabGatewayCapability.tlSystemHeartbeat] = healthState;

                await this.iotCentralPluginModule.sendMeasurement(healthTelemetry, IotcOutputName);
            }

            this.healthState = healthState;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error in healthState (may indicate a critical issue): ${ex.message}`);
            this.healthState = HealthState.Critical;
        }

        if (this.healthState < HealthState.Good) {
            this.server.log([ModuleName, 'warning'], `Health check warning: ${HealthState[healthState]}`);

            if (++this.healthCheckFailStreak >= this.healthCheckRetries) {
                this.server.log([ModuleName, 'warning'], `Health check too many warnings: ${healthState}`);

                await this.restartModule(0, 'checkHealthState');
            }
        }

        return this.healthState;
    }

    public moduleEnvironmentConfig: IModuleEnvironmentConfig = {
        ompAdapterModuleId: process.env.ompAdapterModuleId || 'ompadapter',
        dpsProvisioningHost: process.env.dpsProvisioningHost || 'global.azure-devices-provisioning.net'
    };

    public getModuleSetting(setting: string): any {
        return this.moduleSettings[setting];
    }

    public async iotcApiRequest(uri: string, method: string, options: any): Promise<any> {
        try {
            const iotcApiResponse = await Wreck[method](uri, options);

            if (iotcApiResponse.res.statusCode < 200 || iotcApiResponse.res.statusCode > 299) {
                this.server.log([ModuleName, 'error'], `Response status code = ${iotcApiResponse.res.statusCode}`);

                throw new Error((iotcApiResponse.payload as any)?.message || iotcApiResponse.payload || 'An error occurred');
            }

            return iotcApiResponse;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `iotcApiRequest: ${ex.message}`);
            throw ex;
        }
    }

    private verifyOpcEndpoint(): boolean {
        return !!this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint];
    }

    private async testOpcEndpoint(): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `testOpcEndpoint - url: ${this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint].Uri}`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            if (!this.verifyOpcEndpoint()) {
                response.message = `The OPCUA endpoint property is not set`;
                this.server.log([ModuleName, 'error'], response.message);

                return response;
            }

            const testConnectionResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.moduleEnvironmentConfig.ompAdapterModuleId,
                'TestConnection_v1',
                {
                    OpcEndpoint: this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint]
                },
                10,
                10
            );

            response.status = testConnectionResult.status;

            if (response.status !== 200) {
                response.message = testConnectionResult?.payload?.error?.message || `An error occurred while testing the opcua url`;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                response.message = `testOpcEndpoint succeeded for url: ${this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint].Uri}`;

                this.server.log([ModuleName, 'info'], response.message);
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `testOpcEndpoint failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async fetchNodes(browseNodesRequestParams: IBrowseNodesRequestParams): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `fetchNodes`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            if (!this.verifyOpcEndpoint()) {
                response.message = `The OPCUA endpoint property is not set`;
                this.server.log([ModuleName, 'error'], response.message);

                return response;
            }

            this.server.log([ModuleName, 'info'], `Starting node: ${browseNodesRequestParams.startNode}, depth: ${browseNodesRequestParams.depth}`);

            await this.iotCentralPluginModule.sendMeasurement({
                [MiabGatewayCapability.evFetchedOpcNodesStarted]: `Starting node: ${browseNodesRequestParams.startNode}, depth: ${browseNodesRequestParams.depth}`
            }, IotcOutputName);

            this.server.log([ModuleName, 'info'], `Calling BrowseNodes_v1`);

            const browseNodesResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.moduleEnvironmentConfig.ompAdapterModuleId,
                'BrowseNodes_v1',
                {
                    OpcEndpoint: this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint],
                    StartNode: browseNodesRequestParams.startNode,
                    Depth: browseNodesRequestParams.depth,
                    RequestedAttributes: (browseNodesRequestParams?.requestedAttributes || '').split(',')
                }
            );

            response.status = browseNodesResult.status;

            this.server.log([ModuleName, 'info'], `BrowseNodes_v1 returned status: ${browseNodesResult.status}`);

            if (browseNodesResult.status !== 200 || !browseNodesResult.payload?.JobId) {
                response.message = browseNodesResult?.payload?.error?.message || `Unknown error in the response from fetchNodes - status: ${browseNodesResult.status}`;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                const blobFilename = `fetchNodes-${moment.utc().format('YYYYMMDD-HHmmss')}.json`;
                const fetchedNodesFilePath = resolvePath(this.server.settings.app.storageRootDirectory, blobFilename);

                let fetchBrowsedNodesResult;

                const fetchedNodesFileStream = fileStream(fetchedNodesFilePath);
                fetchedNodesFileStream.create();

                do {
                    const continuationToken = fetchBrowsedNodesResult?.payload?.continuationToken || '1';

                    this.server.log([ModuleName, 'info'], `Calling fetchBrowsedNodes with JobId: ${browseNodesResult.payload.JobId} and ContinuationToken: ${continuationToken}`);

                    fetchBrowsedNodesResult = await this.fetchBrowsedNodes(browseNodesResult.payload.JobId, continuationToken);

                    this.server.log([ModuleName, 'info'], `fetchBrowsedNodes returned status: ${fetchBrowsedNodesResult.status}`);

                    if (fetchBrowsedNodesResult.status === 200 && fetchBrowsedNodesResult?.payload?.nodes) {
                        this.server.log([ModuleName, 'info'], `fetchBrowsedNodes returned ${fetchBrowsedNodesResult.payload.nodes.length} nodes`);

                        await fetchedNodesFileStream.writeJson(fetchBrowsedNodesResult.payload.nodes);
                    }
                } while (fetchBrowsedNodesResult.status === 200 && fetchBrowsedNodesResult?.payload?.continuationToken);

                await fetchedNodesFileStream.close();

                if (fetchBrowsedNodesResult.status === 200) {
                    await this.uploadFetchedNodesFile(fetchedNodesFilePath, blobFilename, 'application/json');
                }

                response.status = fetchBrowsedNodesResult.status;
                response.message = fetchBrowsedNodesResult.message;
                response.payload = fetchBrowsedNodesResult.payload;
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `fetchNodes failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        await this.iotCentralPluginModule.sendMeasurement({
            [MiabGatewayCapability.evFetchedOpcNodesFinished]: `Status: ${response.status}`
        }, IotcOutputName);

        return response;
    }

    private async fetchBrowsedNodes(jobId: string, continuationToken: string): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `fetchBrowsedNodes`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const fetchBrowsedNodesResult = await this.chunkRequest('FetchBrowsedNodes_v1', {
                JobId: jobId,
                ContinuationToken: continuationToken
            });

            Object.assign(response, fetchBrowsedNodesResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `fetchBrowsedNodes failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async uploadFetchedNodesFile(fetchedNodesFilePath: string, blobFilename: string, contentType: string): Promise<boolean> {
        this.server.log([ModuleName, 'info'], `uploadFetchedNodesFile`);

        let result = true;

        try {
            const blobUrl = await this.server.settings.app.blobStorage.putFileIntoBlobStorage(fetchedNodesFilePath, blobFilename, contentType);

            await this.iotCentralPluginModule.sendMeasurement({
                [MiabGatewayCapability.evFetchedOpcNodesUploaded]: blobUrl
            }, IotcOutputName);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error uploading file to blob storage: ${ex.message}`);

            result = false;
        }

        return result;
    }

    private async writeOpcValues(writeNodesRequestParams: IWriteNodesRequestParams): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `writeOpcValues`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            if (!this.verifyOpcEndpoint()) {
                response.message = `The OPCUA endpoint property is not set`;
                this.server.log([ModuleName, 'error'], response.message);

                return response;
            }

            const writeValuesResult = await this.chunkRequest('WriteValues_v1', [
                {
                    OpcEndpoint: this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint],
                    OpcWriteNodes: [
                        {
                            NodeId: writeNodesRequestParams.nodeId,
                            DataValue: JSON.parse(writeNodesRequestParams.value)
                        }
                    ]
                }
            ]);

            Object.assign(response, writeValuesResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `writeOpcValues failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async readOpcValues(readNodesRequestParams: IReadNodesRequestParams): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `readOpcValues`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            if (!this.verifyOpcEndpoint()) {
                response.message = `The OPCUA endpoint property is not set`;
                this.server.log([ModuleName, 'error'], response.message);

                return response;
            }

            const readValuesResult = await this.chunkRequest('ReadValues_v1', [
                {
                    OpcEndpoint: this.moduleSettings[MiabGatewayCapability.wpOpcEndpoint],
                    OpcReadNodes: [
                        {
                            NodeId: readNodesRequestParams.nodeId
                        }
                    ]
                }
            ]);

            Object.assign(response, readValuesResult);
        }
        catch (ex) {
            response.status = 500;
            response.message = `readOpcValues failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async chunkRequest(methodName: string, methodRequest: any): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `chunkRequest`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const compressedRequest = gzipSync(JSON.stringify(methodRequest));

            let chunkResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.moduleEnvironmentConfig.ompAdapterModuleId,
                methodName,
                {
                    ContentLength: compressedRequest.length,
                    Payload: compressedRequest.toString('base64')
                }
            );

            response.status = chunkResult.status;

            if (chunkResult.status !== 202 || !chunkResult.payload?.RequestId) {
                response.message = chunkResult?.payload?.error?.message || `Unknown error in the chunked response from ${methodName} - status: ${chunkResult.status}`;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                do {
                    await sleep(1000);

                    chunkResult = await this.iotCentralPluginModule.invokeDirectMethod(
                        this.moduleEnvironmentConfig.ompAdapterModuleId,
                        methodName,
                        {
                            RequestId: chunkResult.payload.RequestId
                        }
                    );

                    this.server.log([ModuleName, 'info'], `${methodName} returned status: ${chunkResult.status}`);
                } while (chunkResult.status === 102);

                if (chunkResult.status === 200
                    && chunkResult.payload.Status === 200
                    && chunkResult.payload?.Payload?.length) {
                    const resultBuffer = gunzipSync(Buffer.from(chunkResult.payload.Payload, 'base64'));

                    response.message = `${methodName} succeeded`;
                    response.payload = JSON.parse(resultBuffer.toString());
                }
                else {
                    response.message = chunkResult?.payload?.error?.message || `Unknown error in the chunked response from ${methodName} - status: ${chunkResult.status}`;

                    this.server.log([ModuleName, 'error'], response.message);
                }

                response.status = chunkResult.status;
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `${methodName} failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log([ModuleName, 'info'], `restartModule`);

        try {
            await this.iotCentralPluginModule.sendMeasurement({
                [MiabGatewayCapability.evModuleRestart]: reason,
                [MiabGatewayCapability.stModuleState]: ModuleState.Inactive,
                [MiabGatewayCapability.evModuleStopped]: 'Module restart'
            }, IotcOutputName);

            await sleep(1000 * timeout);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `${ex.message}`);
        }

        // let Docker restart our container after 5 additional seconds to allow responses to this method to return
        setTimeout(() => {
            this.server.log([ModuleName, 'info'], `Shutting down main process - module container will restart`);
            process.exit(1);
        }, 1000 * 5);
    }

    private async getSystemProperties(): Promise<ISystemProperties> {
        const cpus = osCpus();
        const cpuUsageSamples = osLoadAvg();

        return {
            cpuModel: cpus[0]?.model || 'Unknown',
            cpuCores: cpus?.length || 0,
            cpuUsage: cpuUsageSamples[0],
            totalMemory: osTotalMem() / 1024,
            freeMemory: osFreeMem() / 1024
        };
    }

    @bind
    private async handleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([ModuleName, 'info'], `${commandRequest.methodName} command received`);

        let response: IModuleCommandResponse = {
            status: 200,
            message: ''
        };

        try {
            switch (commandRequest.methodName) {
                case MiabGatewayCapability.cmTestOpcEndpoint:
                    response = await this.testOpcEndpoint();
                    break;

                case MiabGatewayCapability.cmFetchOpcNodes:
                    response = await this.fetchNodes(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmWriteOpcValues:
                    response = await this.writeOpcValues(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmReadOpcValues:
                    response = await this.readOpcValues(commandRequest.payload);
                    break;

                case MiabGatewayCapability.cmRestartGatewayModule:
                    await this.restartModule((commandRequest?.payload as IRestartGatewayModuleCommandRequestParams)?.timeout || 0, 'RestartModule command received');

                    response.status = 200;
                    response.message = 'Restart module request received';
                    break;

                default:
                    response.status = 400;
                    response.message = `An unknown method name was found: ${commandRequest.methodName}`;
            }

            this.server.log([ModuleName, 'info'], response.message);
        }
        catch (ex) {
            response.status = 400;
            response.message = `An error occurred executing the command ${commandRequest.methodName}: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        await commandResponse.send(200, response);
    }
}
