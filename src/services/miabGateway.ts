import { service, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { DeviceMethodRequest, DeviceMethodResponse } from 'azure-iot-device';
import { IIotCentralPluginModule } from '../plugins/iotCentralModule';
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
import {
    gzipSync,
    gunzipSync
} from 'zlib';
import * as Wreck from '@hapi/wreck';
import { bind, sleep } from '../utils';
import {
    OpcuaEndpoint,
    emptyOpcuaCredential,
    IBrowseNodesRequestParams
} from './miabModels';

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
    wpDebugTelemetry = 'wpDebugTelemetry',
    wpOpcuaEndpoint = 'wpOpcuaEndpoint',
    cmTestOpcuaEndpoint = 'cmTestOpcuaEndpoint',
    cmBrowseOpcuaNodes = 'cmBrowseOpcuaNodes',
    cmRestartGatewayModule = 'cmRestartGatewayModule'
}

interface IMiabGatewaySettings {
    [MiabGatewayCapability.wpDebugTelemetry]: boolean;
    [MiabGatewayCapability.wpOpcuaEndpoint]: OpcuaEndpoint;
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
        [MiabGatewayCapability.wpOpcuaEndpoint]: emptyOpcuaCredential
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

                    case MiabGatewayCapability.wpOpcuaEndpoint:
                        this.moduleSettings[setting] = {
                            ...this.moduleSettings[setting],
                            ...(value || emptyOpcuaCredential)
                        };

                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting],
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

        const systemProperties = await this.getSystemProperties();

        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmTestOpcuaEndpoint, this.handleDirectMethod);
        this.iotCentralPluginModule.addDirectMethod(MiabGatewayCapability.cmBrowseOpcuaNodes, this.handleDirectMethod);
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

    private async testOpcuaEndpoint(): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `testOpcuaEndpoint - url: ${this.moduleSettings[MiabGatewayCapability.wpOpcuaEndpoint].Uri}`);

        const response: IModuleCommandResponse = {
            status: 500,
            message: ``,
            payload: {}
        };

        try {
            const testConnectionResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.moduleEnvironmentConfig.ompAdapterModuleId,
                'TestConnection_v1',
                {
                    OpcEndpoint: this.moduleSettings[MiabGatewayCapability.wpOpcuaEndpoint]
                },
                10,
                10
            );

            response.status = testConnectionResult.status;

            if (response.status !== 200) {
                response.message = testConnectionResult?.payload?.error.message || `An error occurred while testing the opcua url`;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                response.message = `testOpcuaEndpoint succeeded for url: ${this.moduleSettings[MiabGatewayCapability.wpOpcuaEndpoint].Uri}`;

                this.server.log([ModuleName, 'info'], response.message);
            }
        }
        catch (ex) {
            response.status = 500;
            response.message = `testOpcuaEndpoint failed: ${ex.message}`;

            this.server.log([ModuleName, 'error'], response.message);
        }

        return response;
    }

    private async browseNodes(browseNodesRequestParams: IBrowseNodesRequestParams): Promise<IModuleCommandResponse> {
        this.server.log([ModuleName, 'info'], `browseNodes`);

        const response: IModuleCommandResponse = {
            status: 0,
            message: ``,
            payload: {}
        };

        try {
            const browseNodesResult = await this.iotCentralPluginModule.invokeDirectMethod(
                this.moduleEnvironmentConfig.ompAdapterModuleId,
                'BrowseNodes_v1',
                {
                    OpcEndpoint: this.moduleSettings[MiabGatewayCapability.wpOpcuaEndpoint],
                    StartNode: browseNodesRequestParams.StartNode,
                    Depth: browseNodesRequestParams.Depth,
                    RequestedAttributes: (browseNodesRequestParams?.RequestedAttributes || '').split(',')
                }
            );

            response.status = browseNodesResult.status;

            if (browseNodesResult.status !== 200 || !browseNodesResult.payload?.JobId) {
                response.message = browseNodesResult?.payload?.error.message || `Unknown error in the response from BrowseNodes - status: ${browseNodesResult.status}`;

                this.server.log([ModuleName, 'error'], response.message);
            }
            else {
                const fetchBrowsedNodesRequestCompressed = gzipSync(JSON.stringify({
                    JobId: browseNodesResult.payload.JobId,
                    ContinuationToken: '1'
                }));

                let fetchBrowsedNodesResult = await this.iotCentralPluginModule.invokeDirectMethod(
                    this.moduleEnvironmentConfig.ompAdapterModuleId,
                    'FetchBrowsedNodes_v1',
                    {
                        ContentLength: fetchBrowsedNodesRequestCompressed.length,
                        Payload: fetchBrowsedNodesRequestCompressed.toString('base64')
                    }
                );

                response.status = fetchBrowsedNodesResult.status;

                if (fetchBrowsedNodesResult.status !== 202 || !fetchBrowsedNodesResult.payload?.RequestId) {
                    response.message = fetchBrowsedNodesResult?.payload?.error.message || `Unknown error in the response from FetchBrowsedNodes - status: ${fetchBrowsedNodesResult.status}`;

                    this.server.log([ModuleName, 'error'], response.message);
                }
                else {
                    fetchBrowsedNodesResult = await this.iotCentralPluginModule.invokeDirectMethod(
                        this.moduleEnvironmentConfig.ompAdapterModuleId,
                        'FetchBrowsedNodes_v1',
                        {
                            RequestId: fetchBrowsedNodesResult.payload.RequestId
                        }
                    );

                    response.status = fetchBrowsedNodesResult.status;

                    if (fetchBrowsedNodesResult.status !== 200 || !fetchBrowsedNodesResult.payload?.length) {
                        response.message = fetchBrowsedNodesResult?.payload?.error.message || `Unknown error in the response from FetchBrowsedNodes - status: ${fetchBrowsedNodesResult.status}`;

                        this.server.log([ModuleName, 'error'], response.message);
                    }
                    else {
                        // @ts-ignore
                        const foo = gunzipSync(fetchBrowsedNodesResult.payload);

                        response.message = `BrowseNodes succeeded`;
                        response.payload = fetchBrowsedNodesResult.payload;
                    }
                }
            }
        }
        catch (ex) {
            response.status = response.status || 400;
            response.message = `BrowseNodes failed: ${ex.message}`;

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
                case MiabGatewayCapability.cmTestOpcuaEndpoint:
                    response = await this.testOpcuaEndpoint();
                    break;

                case MiabGatewayCapability.cmBrowseOpcuaNodes:
                    response = await this.browseNodes(commandRequest.payload);

                    response.status = 200;
                    response.message = 'Restart module request received';

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
