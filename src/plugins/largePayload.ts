import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import { Message } from 'azure-iot-device';
import { v4 as uuidv4 } from 'uuid';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        largePayload?: ILargePayloadPluginModule;
    }
}

const ModuleName = 'LargePayloadPluginModule';

const maxMessageSize = 255 * 1024;
const messageTemplate = { data: '' };
const maxChunkSize = maxMessageSize - JSON.stringify(messageTemplate, null).length;
const IotcOutputName = 'iotc';

export interface IUploadContext {
    id: string;
    compressed: boolean;
    multipart: boolean;
    partNumber: number;
    destinationPath: string;
}

export interface ILargePayloadPluginModuleOptions {
    option1: string;
}

export interface ILargePayloadPluginModule {
    createUploadTelemetryContext(compressed: boolean, destinationPath: string): Promise<IUploadContext>;
    sendUploadTelemetryPayload(uploadContext: IUploadContext, payload: any): Promise<boolean>;
    closeUploadTelemetryContext(uploadContext: IUploadContext, totalSize: number, status: number): Promise<boolean>;
}

export class LargePayloadPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], `init`);
    }

    public async register(server: Server, options: ILargePayloadPluginModuleOptions): Promise<void> {
        server.log([ModuleName, 'info'], 'register');

        try {
            server.settings.app.largePayload = new LargePayloadPluginModule(server, options);
        }
        catch (ex) {
            server.log([ModuleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

class LargePayloadPluginModule implements ILargePayloadPluginModule {
    private server: Server;
    // @ts-ignore
    private options: ILargePayloadPluginModuleOptions;

    constructor(server: Server, options: ILargePayloadPluginModuleOptions) {
        this.server = server;
        this.options = options;
    }

    public async createUploadTelemetryContext(compressed: boolean, destinationPath: string): Promise<IUploadContext> {
        return {
            id: uuidv4(),
            compressed,
            multipart: true,
            partNumber: 0,
            destinationPath
        };
    }

    public async sendUploadTelemetryPayload(uploadContext: IUploadContext, payload: any): Promise<boolean> {
        let result = false;

        try {
            const messageChunk = {
                data: payload
            };

            // mutating the context...
            uploadContext.partNumber++;

            await this.sendTelemetry(messageChunk, uploadContext);

            this.server.log([ModuleName, 'info'], `Sent multipart payload part number: ${uploadContext.partNumber}`);

            result = true;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error sending multipart payload: ${ex.message}`);
        }

        return result;
    }

    public async closeUploadTelemetryContext(uploadContext: IUploadContext, totalSize: number, status: number): Promise<boolean> {
        let result = false;

        try {
            // const maxParts = Math.ceil(fileDataCompressed.length / maxChunkSize);

            const uploadTelemetryStatus = {
                ...uploadContext,
                maxParts: Math.ceil(totalSize / maxChunkSize),
                status
            };

            await this.sendTelemetry(uploadTelemetryStatus);

            this.server.log([ModuleName, 'info'], `Sent multipart payload part status - maxParts: ${uploadTelemetryStatus.maxParts}`);

            result = true;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error sending final multipart payload status: ${ex.message}`);
        }

        return result;
    }

    private async sendTelemetry(telemetryData: any, messageProperties: any = {}, contentType: 'application/json' = 'application/json', encoding: 'utf-8' = 'utf-8'): Promise<boolean> {
        let result = false;

        if (this.server.settings.app?.iotCentral?.moduleClient) {
            try {
                const telemetryMessage = new Message(JSON.stringify(telemetryData));

                telemetryMessage.contentType = contentType;  // when we support binary payload this should be changed to application / octet - stream
                telemetryMessage.contentEncoding = encoding; // encoding for the payload utf - 8 for JSON and can be left off for binary data

                for (const prop of Object.keys(messageProperties || {})) {
                    telemetryMessage.properties.add(prop, messageProperties[prop]);
                }

                await this.server.settings.app.iotCentral.moduleClient.sendOutputEvent(IotcOutputName, telemetryMessage);

                result = true;
            }
            catch (ex) {
                this.server.log([ModuleName, 'error'], `Error sending file telemetry: ${ex.message}`);
            }
        }

        return result;
    }
}
