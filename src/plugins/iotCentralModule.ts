import { Server, Plugin } from '@hapi/hapi';
import { Mqtt } from 'azure-iot-device-mqtt';
import {
    ModuleClient,
    Twin,
    Message as IoTMessage,
    DeviceMethodRequest,
    DeviceMethodResponse
} from 'azure-iot-device';
import {
    pipeline,
    Transform,
    TransformCallback
} from 'stream';
import { createGzip } from 'zlib';
import * as fse from 'fs-extra';
import {
    basename as pathBasename
} from 'path';
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
import { v4 as uuidv4 } from 'uuid';
import { HealthState } from '../services/health';
import { bind, defer, sleep } from '../utils';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        iotCentral?: IIotCentralPluginModule;
    }
}

const PluginName = 'IotCentralPlugin';
const ModuleName = 'IotCentralPluginModule';
const LargePayloadModule = 'LargePayloadModule';
const defaultHealthCheckRetries = 3;

export const IotcOutputName = 'iotc';

export interface IDirectMethodResult {
    status: number;
    payload: any;
}

type DirectMethodFunction = (commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) => Promise<void>;

export interface IIotCentralPluginModuleOptions {
    initializeModule(): Promise<void>;
    onHandleModuleProperties(desiredProps: any): Promise<void>;
    onHandleDownstreamMessages?(inputName: string, message: IoTMessage): Promise<void>;
    onModuleConnect?(): void;
    onModuleDisconnect?(): void;
    onModuleClientError?(error: Error): void;
    onModuleReady(): Promise<void>;
    onHealth(): Promise<HealthState>;
}

export interface IIotCentralPluginModule {
    moduleId: string;
    deviceId: string;
    moduleClient: ModuleClient;
    debugTelemetry(): boolean;
    getHealth(): Promise<HealthState>;
    sendMeasurement(data: any, outputName?: string): Promise<void>;
    updateModuleProperties(properties: any): Promise<void>;
    addDirectMethod(directMethodName: string, directMethodFunction: DirectMethodFunction): void;
    invokeDirectMethod(moduleId: string, methodName: string, payload: any, connectTimeout?: number, responseTimeout?: number): Promise<IDirectMethodResult>;
    sendLargePayload(localFilepath: string): Promise<void>;
}

export const iotCentralPluginModule: Plugin<any> = {
    name: 'IotCentralPluginModule',

    register: async (server: Server, options: IIotCentralPluginModuleOptions): Promise<void> => {
        server.log([PluginName, 'info'], 'register');

        if (!options.onHealth) {
            throw new Error('Missing required option onHealth in IoTCentralModuleOptions');
        }

        if (!options.onHandleModuleProperties) {
            throw new Error('Missing required option onHandleModuleProperties in IoTCentralModuleOptions');
        }

        if (!options.onModuleReady) {
            throw new Error('Missing required option onModuleReady in IoTCentralModuleOptions');
        }

        const plugin = new IotCentralPluginModule(server, options);

        server.settings.app.iotCentral = plugin;

        await plugin.startModule();
    }
};

interface ILargePayloadTelemetryChunk {
    mp: string; // '1' = true
    ji: string; // guid
    fn: string; // base filename with extension
    pt: string; // part number (string)
    gz: string; // gzipped, '1' = true
}

interface ILargePayloadTelemetryStatus {
    ji: string; // guid
    fn: string; // base filename with extension
    st: string; // upload status (200 = success, 500 = exception)
    sm: string; // status message
    sz: string; // file size total compressed file size of all chunks
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

export interface IModuleCommandResponse {
    status: number;
    message: string;
    payload?: any;
}

enum IoTCentralModuleCapability {
    tlSystemHeartbeat = 'tlSystemHeartbeat',
    tlFreeMemory = 'tlFreeMemory',
    stIoTCentralClientState = 'stIoTCentralClientState',
    stModuleState = 'stModuleState',
    evModuleStarted = 'evModuleStarted',
    evModuleStopped = 'evModuleStopped',
    evModuleRestart = 'evModuleRestart',
    evLargePayloadStatus = 'evLargePayloadStatus',
    wpDebugTelemetry = 'wpDebugTelemetry',
    cmRestartGatewayModule = 'cmRestartGatewayModule'
}

interface IIoTCentralModuleSettings {
    [IoTCentralModuleCapability.wpDebugTelemetry]: boolean;
}

class IotCentralPluginModule implements IIotCentralPluginModule {
    private server: Server;
    private moduleTwin: Twin = null;
    private deferredStart = defer();
    private options: IIotCentralPluginModuleOptions;
    private healthCheckRetries: number = defaultHealthCheckRetries;
    private healthState = HealthState.Good;
    private healthCheckFailStreak = 0;
    private moduleSettings: IIoTCentralModuleSettings = {
        [IoTCentralModuleCapability.wpDebugTelemetry]: false
    };

    constructor(server: Server, options: IIotCentralPluginModuleOptions) {
        this.server = server;
        this.options = options;
    }

    public async startModule(): Promise<boolean> {
        let result = false;

        try {
            await this.options.initializeModule();

            for (let connectCount = 1; !result && connectCount <= 3; connectCount++) {
                result = await this.connectModuleClient();

                if (!result) {
                    this.server.log([ModuleName, 'error'], `Connect client attempt failed (${connectCount} of 3)${connectCount < 3 ? ' - retry in 5 seconds' : ''}`);
                    await sleep(5000);
                }
            }

            if (result) {
                await this.deferredStart.promise;

                await this.options.onModuleReady();

                this.healthCheckRetries = Number(process.env.healthCheckRetries) || defaultHealthCheckRetries;

                const systemProperties = await this.getSystemProperties();

                this.addDirectMethod(IoTCentralModuleCapability.cmRestartGatewayModule, this.handleDirectMethod);

                await this.updateModuleProperties({
                    [IotcEdgeHostDevicePropNames.ProcessorArchitecture]: osArch() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.Hostname]: osHostname() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.Platform]: osPlatform() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.OsType]: osType() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.OsName]: osRelease() || 'Unknown',
                    [IotcEdgeHostDevicePropNames.TotalMemory]: systemProperties.totalMemory || 0,
                    [IotcEdgeHostDevicePropNames.SwVersion]: osVersion() || 'Unknown'
                });

                await this.sendMeasurement({
                    [IoTCentralModuleCapability.stIoTCentralClientState]: IoTCentralClientState.Connected,
                    [IoTCentralModuleCapability.stModuleState]: ModuleState.Active,
                    [IoTCentralModuleCapability.evModuleStarted]: 'Module initialization'
                }, IotcOutputName);
            }
        }
        catch (ex) {
            result = false;

            this.server.log([ModuleName, 'error'], `Exception while starting IotCentralModule plugin: ${ex.message}`);
        }

        return result;
    }

    public moduleId: string = process.env.IOTEDGE_MODULEID || '';
    public deviceId: string = process.env.IOTEDGE_DEVICEID || '';
    public moduleClient: ModuleClient = null;

    public debugTelemetry(): boolean {
        return this.moduleSettings[IoTCentralModuleCapability.wpDebugTelemetry];
    }

    public async getHealth(): Promise<HealthState> {
        if (!this.moduleClient) {
            return this.healthState;
        }

        let healthState = this.healthState;

        try {
            if (healthState === HealthState.Good) {
                const healthTelemetry = {};
                const systemProperties = await this.getSystemProperties();
                const freeMemory = systemProperties?.freeMemory || 0;

                healthTelemetry[IoTCentralModuleCapability.tlFreeMemory] = freeMemory;

                // TODO:
                // Find the right threshold for this metric
                if (freeMemory === 0) {
                    healthState = HealthState.Critical;
                }
                else {
                    healthState = await this.options.onHealth();
                }

                healthTelemetry[IoTCentralModuleCapability.tlSystemHeartbeat] = healthState;

                await this.sendMeasurement(healthTelemetry, IotcOutputName);
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

    public async sendMeasurement(data: any, outputName?: string): Promise<void> {
        if (!data || !this.moduleClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            if (outputName) {
                await this.moduleClient.sendOutputEvent(outputName, iotcMessage);
            }
            else {
                await this.moduleClient.sendEvent(iotcMessage);
            }

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `sendMeasurement: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `sendMeasurement: ${ex.message}`);
        }
    }

    public async updateModuleProperties(properties: any): Promise<void> {
        if (!properties || !this.moduleTwin) {
            return;
        }

        try {
            await new Promise((resolve, reject) => {
                this.moduleTwin.properties.reported.update(properties, (error) => {
                    if (error) {
                        return reject(error);
                    }

                    return resolve('');
                });
            });

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `Module properties updated: ${JSON.stringify(properties, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error updating module properties: ${ex.message}`);
        }
    }

    public addDirectMethod(directMethodName: string, directMethodFunction: DirectMethodFunction): void {
        if (!this.moduleClient) {
            return;
        }

        this.moduleClient.onMethod(directMethodName, directMethodFunction);
    }

    public async invokeDirectMethod(moduleId: string, methodName: string, payload: any, connectTimeout?: number, responseTimeout?: number): Promise<IDirectMethodResult> {
        const directMethodResult: IDirectMethodResult = {
            status: 200,
            payload: {}
        };

        if (!this.moduleClient) {
            return directMethodResult;
        }

        try {
            const methodParams = {
                methodName,
                payload,
                connectTimeoutInSeconds: connectTimeout,
                responseTimeoutInSeconds: responseTimeout
            };

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `invokeModuleMethod request: ${JSON.stringify(methodParams, null, 4)}`);
            }

            const response = await this.moduleClient.invokeMethod(this.deviceId, moduleId, methodParams);

            if (this.debugTelemetry()) {
                this.server.log([ModuleName, 'info'], `invokeModuleMethod response: ${JSON.stringify(response, null, 4)}`);
            }

            directMethodResult.status = response.status;
            directMethodResult.payload = response.payload || {};

            if (response.status < 200 || response.status > 299) {
                // throw new Error(`(from invokeMethod) ${response.payload.error?.message}`);
                this.server.log([ModuleName, 'error'], `Error executing directMethod ${methodName} on module ${moduleId}, status: ${response.status}`);
            }
        }
        catch (ex) {
            directMethodResult.status = 500;
            this.server.log([ModuleName, 'error'], `Exception while calling invokeMethod: ${ex.message}`);
        }

        return directMethodResult;
    }

    public async sendLargePayload(localFilepath: string): Promise<void> {
        this.server.log([LargePayloadModule, 'info'], `sendLargePayload`);

        try {
            this.server.log([LargePayloadModule, 'info'], `Preparing to gzip file at ${localFilepath}`);

            const baseFilename = pathBasename(localFilepath);

            // Base64 encodes each set of 3 bytes into 4 bytes. Also, the output
            // is padded to be a multiple of 4. The size of the base64 converted
            // bytes of size (n) is Math.ceil(n / 3) * 4. So, if we have a budget
            // of 256Kb chunks (IoT Hub telemetry budget) we will use .75 of that
            // or 192Kb.
            const payloadOverhead = JSON.stringify({
                data: {}
            }).length;
            const payloadMin = (1024 * 192) - payloadOverhead;
            const payloadMax = (1024 * 256) - payloadOverhead;

            let iChunk = 0;
            let chunkBytes = 0;
            let totalBytes = 0;
            const jobId = uuidv4();
            const chunkSize = 1024 * 16;
            const chunkBuffers: Buffer[] = [];
            const fileUploadTransform = new FileUploadTransform(this, {
                async transform(chunk: any, _encoding: BufferEncoding, done: TransformCallback): Promise<void> {
                    try {
                        const length = chunk.length;

                        totalBytes += length;
                        chunkBytes += length;

                        if (chunkBytes + chunkSize >= payloadMin && chunkBytes + chunkSize <= payloadMax) {
                            this.iotcPluginModule.server.log([LargePayloadModule, 'info'], `chunkSize: ${length}, chunkBytes: ${chunkBytes}, totalBytes: ${totalBytes}`);

                            chunkBuffers.push(chunk);

                            const chunkProps: ILargePayloadTelemetryChunk = {
                                mp: '1',
                                ji: jobId,
                                fn: baseFilename,
                                pt: `${iChunk++}`,
                                gz: '1'
                            };

                            await this.iotcPluginModule.sendLargePayloadMessage({
                                data: Buffer.concat(chunkBuffers).toString('base64')
                            }, chunkProps);

                            chunkBuffers.length = 0;
                            chunkBytes = 0;
                        }
                        else {
                            chunkBuffers.push(chunk);

                            this.iotcPluginModule.server.log([LargePayloadModule, 'info'], `    chunkSize: ${length}, chunkBytes: ${chunkBytes}, totalBytes: ${totalBytes}`);
                        }
                    }
                    catch (ex) {
                        this.iotcPluginModule.server.log([LargePayloadModule, 'error'], `Error during transform chunk processing: ${ex.message}`);
                    }

                    return done();
                },
                async flush(done: TransformCallback): Promise<void> {
                    try {
                        if (chunkBytes) {
                            this.iotcPluginModule.server.log([LargePayloadModule, 'info'], `chunkSize: ${chunkBytes}, chunkBytes: ${chunkBytes}, totalBytes: ${totalBytes}`);

                            const chunkProps: ILargePayloadTelemetryChunk = {
                                mp: '1',
                                ji: jobId,
                                fn: baseFilename,
                                pt: `${iChunk++}`,
                                gz: '1'
                            };

                            await this.iotcPluginModule.sendLargePayloadMessage({
                                data: Buffer.concat(chunkBuffers).toString('base64')
                            }, chunkProps);
                        }
                    }
                    catch (ex) {
                        this.iotcPluginModule.server.log([LargePayloadModule, 'error'], `Error during transform final flush: ${ex.message}`);
                    }

                    return done();
                }
            });

            this.server.log([LargePayloadModule, 'info'], `Starting gzip and upload pipeline on file: ${localFilepath}`);

            const r = fse.createReadStream(localFilepath);
            const z = createGzip();
            pipeline(
                r,
                z,
                fileUploadTransform,
                async (err) => {
                    let statusCode = 200;
                    let statusMessage = '';

                    if (err) {
                        statusCode = 500;
                        statusMessage = `Error during upload pipeline processing: ${err.message}`;

                        this.server.log([LargePayloadModule, 'error'], statusMessage);
                    }
                    else {
                        this.server.log([LargePayloadModule, 'info'], `Upload pipeline processing succeeded`);

                        statusMessage = `LF Payload, JobId: ${jobId}, st: ${statusCode}, sz: ${totalBytes}, fn: ${baseFilename}`;
                    }

                    const statusTelemetry: ILargePayloadTelemetryStatus = {
                        ji: jobId,
                        fn: baseFilename,
                        st: `${statusCode}`,
                        sm: statusMessage,
                        sz: `${totalBytes}`
                    };

                    await this.sendLargePayloadMessage({
                        [IoTCentralModuleCapability.evLargePayloadStatus]: statusTelemetry
                    });
                }
            );
        }
        catch (ex) {
            this.server.log([LargePayloadModule, 'error'], `Error preparing file for large payload upload: ${ex.message} `);
        }

        return;
    }

    public async sendLargePayloadMessage(data: any, properties?: any): Promise<void> {
        if (!data || !this.moduleClient) {
            return;
        }

        try {
            const iotcMessage = new IoTMessage(JSON.stringify(data));

            iotcMessage.contentType = 'application/json';
            iotcMessage.contentEncoding = 'utf-8';

            if (this.debugTelemetry() && properties) {
                this.server.log([LargePayloadModule, 'info'], `sendLargePayloadMessage included properties: ${JSON.stringify(properties, null, 4)}`);
            }

            for (const prop in properties) {
                if (!Object.prototype.hasOwnProperty.call(properties, prop)) {
                    continue;
                }

                iotcMessage.properties.add(prop, properties[prop]);
            }

            await this.moduleClient.sendOutputEvent(IotcOutputName, iotcMessage);

            if (this.debugTelemetry()) {
                this.server.log([LargePayloadModule, 'info'], `sendLargePayloadMessage: ${JSON.stringify(data, null, 4)}`);
            }
        }
        catch (ex) {
            this.server.log([LargePayloadModule, 'error'], `sendLargePayloadMessage: ${ex.message}`);
        }
    }

    private async connectModuleClient(): Promise<boolean> {
        let result = true;

        if (this.moduleClient) {
            if (this.moduleTwin) {
                this.moduleTwin.removeAllListeners();
            }

            if (this.moduleClient) {
                this.moduleClient.removeAllListeners();

                await this.moduleClient.close();
            }

            this.moduleClient = null;
            this.moduleTwin = null;
        }

        try {
            this.server.log([ModuleName, 'info'], `IOTEDGE_WORKLOADURI: ${process.env.IOTEDGE_WORKLOADURI} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_DEVICEID: ${process.env.IOTEDGE_DEVICEID} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_MODULEID: ${process.env.IOTEDGE_MODULEID} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_MODULEGENERATIONID: ${process.env.IOTEDGE_MODULEGENERATIONID} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_IOTHUBHOSTNAME: ${process.env.IOTEDGE_IOTHUBHOSTNAME} `);
            this.server.log([ModuleName, 'info'], `IOTEDGE_AUTHSCHEME: ${process.env.IOTEDGE_AUTHSCHEME} `);

            this.moduleClient = await ModuleClient.fromEnvironment(Mqtt);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Failed to instantiate client interface from configuraiton: ${ex.message} `);
        }

        if (!this.moduleClient) {
            return false;
        }

        try {
            this.moduleClient.on('connect', this.onModuleConnect);
            this.moduleClient.on('disconnect', this.onModuleDisconnect);
            this.moduleClient.on('error', this.onModuleClientError);

            this.server.log([ModuleName, 'info'], `Waiting for dependent modules to initialize(approx. 15s)...`);
            await sleep(15000);

            await this.moduleClient.open();

            this.server.log([ModuleName, 'info'], `Client is connected`);

            // TODO:
            // Should the module twin interface get connected *BEFORE* opening
            // the moduleClient above?
            this.moduleTwin = await this.moduleClient.getTwin();
            this.moduleTwin.on('properties.desired', this.onHandleModuleProperties);
            this.moduleClient.on('inputMessage', this.onHandleDownstreamMessages);

            this.server.log([ModuleName, 'info'], `IoT Central successfully connected module: ${process.env.IOTEDGE_MODULEID}, instance id: ${process.env.IOTEDGE_DEVICEID} `);
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `IoT Central connection error: ${ex.message} `);

            result = false;
        }

        return result;
    }

    @bind
    private async onHandleModuleProperties(desiredChangedSettings: any): Promise<void> {
        if (!this.moduleClient) {
            return;
        }

        this.server.log([ModuleName, 'info'], `onHandleModuleProperties`);
        if (this.debugTelemetry()) {
            this.server.log([ModuleName, 'info'], `desiredChangedSettings:\n${JSON.stringify(desiredChangedSettings, null, 4)}`);
        }

        await this.options.onHandleModuleProperties(desiredChangedSettings);

        try {
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
                    case IoTCentralModuleCapability.wpDebugTelemetry:
                        patchedProperties[setting] = {
                            value: this.moduleSettings[setting] = value || false,
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
                await this.updateModuleProperties(patchedProperties);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Exception while handling desired properties: ${ex.message}`);
        }

        this.deferredStart.resolve();
    }

    @bind
    private async onHandleDownstreamMessages(inputName: string, message: IoTMessage): Promise<void> {
        if (!this.moduleClient || !message) {
            return;
        }

        if (this.options.onHandleDownstreamMessages) {
            await this.options.onHandleDownstreamMessages(inputName, message);
        }
    }

    @bind
    private onModuleConnect() {
        if (this.options.onModuleConnect) {
            this.options.onModuleConnect();
        }
        else {
            this.server.log([ModuleName, 'info'], `The module received a connect event`);
        }
    }

    @bind
    private onModuleDisconnect() {
        if (this.options.onModuleDisconnect) {
            this.options.onModuleDisconnect();
        }
        else {
            this.server.log([ModuleName, 'info'], `The module received a disconnect event`);
        }
    }

    @bind
    private onModuleClientError(error: Error) {
        try {
            this.moduleClient = null;
            this.moduleTwin = null;

            if (this.options.onModuleClientError) {
                this.options.onModuleClientError(error);
            }
            else {
                this.server.log([ModuleName, 'error'], `Module client connection error: ${error.message} `);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Module client connection error: ${ex.message} `);
        }
    }

    @bind
    private async handleDirectMethod(commandRequest: DeviceMethodRequest, commandResponse: DeviceMethodResponse) {
        this.server.log([ModuleName, 'info'], `${commandRequest.methodName} command received`);

        const response: IModuleCommandResponse = {
            status: 200,
            message: ''
        };

        try {
            switch (commandRequest.methodName) {
                case IoTCentralModuleCapability.cmRestartGatewayModule:
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

    private async restartModule(timeout: number, reason: string): Promise<void> {
        this.server.log([ModuleName, 'info'], `restartModule`);

        try {
            await this.sendMeasurement({
                [IoTCentralModuleCapability.evModuleRestart]: reason,
                [IoTCentralModuleCapability.stModuleState]: ModuleState.Inactive,
                [IoTCentralModuleCapability.evModuleStopped]: 'Module restart'
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
}

class FileUploadTransform extends Transform {
    public iotcPluginModule: IotCentralPluginModule;

    constructor(iotcPluginModule: IotCentralPluginModule, options: any) {
        super(options);

        this.iotcPluginModule = iotcPluginModule;
    }

    public _transform(chunk, _encoding, done): Promise<void> {
        this.push(chunk);

        return done();
    }

    public _flush(done) {
        return done();
    }
}
