import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    ContainerCreateOptions,
    BlobServiceClient,
    ContainerClient
} from '@azure/storage-blob';
import { Readable } from 'stream';

declare module '@hapi/hapi' {
    interface ServerOptionsApp {
        blobStorage?: IBlobStoragePluginModule;
    }
}

const ModuleName = 'BlobStoragePluginModule';

export interface IBlobStoragePluginModuleOptions {
    blobConnectionString: string;
    blobContainerName: string;
}

export interface IBlobStoragePluginModule {
    configureBlobStorageClient(pluginOptions: IBlobStoragePluginModuleOptions): boolean;
    getFileFromBlobStorage(fileName: string): Promise<any>;
    putFileIntoBlobStorage(localFilePath: string, blobName: string, contentType: string): Promise<string>;
    uploadBase64ImageToBlobStorageContainer(base64Data: string, blobName: string): Promise<string>;
}

export class BlobStoragePlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], `init`);
    }

    public async register(server: Server, _options: IBlobStoragePluginModuleOptions): Promise<void> {
        server.log([ModuleName, 'info'], 'register');

        try {
            server.settings.app.blobStorage = new BlobStoragePluginModule(server);
        }
        catch (ex) {
            server.log([ModuleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}

class BlobStoragePluginModule implements IBlobStoragePluginModule {
    private server: Server;
    private options: IBlobStoragePluginModuleOptions;
    private blobStorageServiceClient: BlobServiceClient;

    constructor(server: Server) {
        this.server = server;
    }

    public configureBlobStorageClient(pluginOptions: IBlobStoragePluginModuleOptions): boolean {
        this.server.log([ModuleName, 'info'], `configureBlobStorageClient`);

        if (!this.ensureBlobServiceClient(pluginOptions)) {
            this.server.log([ModuleName, 'error'], `Error creating the Blob Storage service client`);
            return false;
        }

        this.options = {
            ...pluginOptions
        };

        return true;
    }

    public async getFileFromBlobStorage(fileName: string): Promise<any> {
        this.server.log([ModuleName, 'info'], `getFileFromBlobStorage`);

        if (!this.ensureBlobServiceClient()) {
            this.server.log([ModuleName, 'error'], `No Blob Storage Service client is configured for file download`);
            return;
        }

        try {
            const containerClient = this.blobStorageServiceClient.getContainerClient(this.options.blobContainerName);
            const containerExists = await containerClient.exists();
            if (!containerExists) {
                this.server.log([ModuleName, 'error'], `The destination blob storage container does not exist: ${this.options.blobContainerName}`);
                return;
            }

            const blobClient = containerClient.getBlobClient(fileName);

            const downloadBlockBlobResponse = await blobClient.download();
            const bufferData = await this.streamToBuffer(downloadBlockBlobResponse.readableStreamBody);

            return JSON.parse(bufferData.toString());
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while downloading blob file: ${ex.message}`);
        }

        return;
    }

    public async putFileIntoBlobStorage(localFilePath: string, blobName: string, contentType: string): Promise<string> {
        this.server.log([ModuleName, 'info'], `putFileIntoBlobStorage`);

        let fileUrl = '';

        if (!this.ensureBlobServiceClient()) {
            this.server.log([ModuleName, 'error'], `No Blob Storage Service client is configured for file upload`);
            return '';
        }

        try {
            this.server.log([ModuleName, 'info'], `Preparing to upload file content to blob storage container`);

            const containerClient = await this.ensureContainer(this.options.blobContainerName, { access: 'container' });
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            const uploadResponse = await blockBlobClient.uploadFile(localFilePath, {
                blobHTTPHeaders: {
                    blobContentType: contentType
                }
            });

            // eslint-disable-next-line no-underscore-dangle
            if (uploadResponse?._response.status === 201) {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([ModuleName, 'info'], `Success - status: ${uploadResponse?._response.status}, path: ${blockBlobClient.url}`);

                fileUrl = blockBlobClient.url;
            }
            else {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([ModuleName, 'info'], `Error while uploading content to blob storage - status: ${uploadResponse?._response.status}, code: ${uploadResponse?.errorCode}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while uploading content to blob storage container: ${ex.message}`);
        }

        return fileUrl;
    }

    public async uploadBase64ImageToBlobStorageContainer(base64Data: string, blobName: string): Promise<string> {
        this.server.log([ModuleName, 'info'], `uploadBase64ImageToBlobStorageContainer`);

        let imageUrl = '';

        if (!this.ensureBlobServiceClient()) {
            this.server.log([ModuleName, 'error'], `No Blob Storage Service client is configured for image upload`);
            return '';
        }

        try {
            this.server.log([ModuleName, 'info'], `Preparing to upload image content to blob storage container`);

            const containerClient = await this.ensureContainer(this.options.blobContainerName, { access: 'container' });
            const blockBlobClient = containerClient.getBlockBlobClient(blobName);

            const bufferData = Buffer.from(base64Data, 'base64');
            const readableStream = new Readable({
                read() {
                    this.push(bufferData);
                    this.push(null);
                }
            });

            const uploadResponse = await blockBlobClient.uploadStream(readableStream, bufferData.length, 5, {
                blobHTTPHeaders: {
                    blobContentType: 'image/jpeg'
                }
            });

            // eslint-disable-next-line no-underscore-dangle
            if (uploadResponse?._response.status === 201) {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([ModuleName, 'info'], `Success - status: ${uploadResponse?._response.status}, path: ${blockBlobClient.url}`);

                imageUrl = blockBlobClient.url;
            }
            else {
                // eslint-disable-next-line no-underscore-dangle
                this.server.log([ModuleName, 'info'], `Error while uploading content to blob storage - status: ${uploadResponse?._response.status}, code: ${uploadResponse?.errorCode}`);
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error while uploading content to blob storage container: ${ex.message}`);
        }

        return imageUrl;
    }

    private ensureBlobServiceClient(pluginOptions?: IBlobStoragePluginModuleOptions): boolean {
        try {
            if (pluginOptions && !this.blobStorageServiceClient) {
                this.blobStorageServiceClient = BlobServiceClient.fromConnectionString(pluginOptions.blobConnectionString);
            }

            return !!this.blobStorageServiceClient;
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error creating the Blob Storage service shared key and client: ${ex.message}`);
        }

        return false;
    }

    private async ensureContainer(containerName: string, options?: ContainerCreateOptions): Promise<ContainerClient> {
        let blobStoreContainerClient;

        try {
            blobStoreContainerClient = this.blobStorageServiceClient.getContainerClient(containerName);

            const containerExists = await blobStoreContainerClient.exists();
            if (!containerExists) {
                const { containerClient, containerCreateResponse } = await this.blobStorageServiceClient.createContainer(containerName, options);
                // eslint-disable-next-line no-underscore-dangle
                if (containerCreateResponse?._response.status === 201) {
                    // eslint-disable-next-line no-underscore-dangle
                    this.server.log([ModuleName, 'info'], `Created blob storage container: ${containerCreateResponse?._response.status}, path: ${containerName}`);

                    blobStoreContainerClient = containerClient;
                }
                else {
                    // eslint-disable-next-line no-underscore-dangle
                    this.server.log([ModuleName, 'info'], `Error creating blob storage container: ${containerCreateResponse?._response.status}, code: ${containerCreateResponse?.errorCode}`);
                }
            }
        }
        catch (ex) {
            this.server.log([ModuleName, 'error'], `Error accessing blob store container ${containerName}: ${ex.message}`);
        }

        return blobStoreContainerClient;
    }

    private async streamToBuffer(readableStream): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const chunks = [];

            readableStream.on('data', (data) => {
                chunks.push(data instanceof Buffer ? data : Buffer.from(data));
            });

            readableStream.on('end', () => {
                resolve(Buffer.concat(chunks));
            });

            readableStream.on('error', reject);
        });
    }
}
