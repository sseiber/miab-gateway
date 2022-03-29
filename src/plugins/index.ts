
import { ConfigPlugin } from './config';
import { BlobStoragePlugin } from './blobStorage';
import { LargePayloadPlugin } from './largePayload';
import { MiabGatewayPlugin } from './miabGateway';

export default [
    ConfigPlugin,
    BlobStoragePlugin,
    LargePayloadPlugin,
    MiabGatewayPlugin
];
