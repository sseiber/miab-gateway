export enum SecurityMode {
    Lowest = 'Lowest',
    Best = 'Best'
}

export enum EndpointCredentialType {
    Anonymous = 'Anonymous',
    Username = 'Username'
}

export interface IEndpointCredentials {
    credentialType: EndpointCredentialType;
    username: string;
    password: string;
}

export interface IEndpoint {
    uri: string;
    securityMode: SecurityMode;
    credentials: IEndpointCredentials;
}

export enum OpcNodeClass {
    Object = 'Object',
    Variable = 'Variable'
}

export enum OpcAttribute {
    NodeClass = 'NodeClass',
    BrowseName = 'BrowseName',
    DisplayName = 'DisplayName',
    Description = 'Description',
    Value = 'Value',
    DataType = 'DataType',
    ValueRank = 'ValueRank',
    ArrayDimensions = 'ArrayDimensions',
    UserAccessLevel = 'UserAccessLevel'
}

export interface IOpcDataValue {
    status: string;
    value: any;
    sourceTimestamp: Date;
    serverTimestamp: Date;
}

export interface IOpcWriteNode {
    nodeId: string;
    dataValue: IOpcDataValue;
}

export interface IOpcReadNode {
    nodeId: string;
    dataValue: IOpcDataValue;
}

export enum DeviceCredentialType {
    X509Certificate = 'X509Certificate',
    SymmetricKey = 'SymmetricKey'
}

export interface IDeviceCredentials {
    type: DeviceCredentialType;
    x509Certificate: Uint8Array;
    primaryKey: string;
    secondaryKey: string;
    idScope: string;
}

export interface INodeSubscriptionConfiguration {
    nodeId: string;
    displayName: string;
    publishingIntervalMilliseconds: number;
    samplingIntervalMilliseconds: number;
}

export interface IAsset {
    assetId: string;
    lastChanged: Date;
    ioTHubMessageProperties: Record<string, string>;
    publishingIntervalMilliseconds: number;
    samplingIntervalMilliseconds: number;
    opcEndpoint: IEndpoint;
    nodes: INodeSubscriptionConfiguration[];
    deviceCredentials: IDeviceCredentials;
}

export interface ITestConnectionRequest {
    opcEndpoint: IEndpoint;
}

export interface IBrowseNodesRequest {
    opcEndpoint: IEndpoint;
    startNode: string;
    depth: number;
    requestedNodeClasses: OpcNodeClass[];
    requestedAttributes: OpcAttribute[];
}

export interface IWriteValuesRequest {
    endpoint: IEndpoint;
    opcReadNodes: IOpcWriteNode[];
}

export interface IReadValuesRequest {
    endpoint: IEndpoint;
    opcReadNodes: IOpcReadNode[];
}

export interface IAddOrUpdateAssetRequest {
    asset: IAsset;
    skipNodeValidation: boolean;
}

export interface IRemoveAssetRequest {
    assetId: string;
}

export const emptyEndpoint: IEndpoint = {
    uri: '',
    securityMode: SecurityMode.Lowest,
    credentials: {
        credentialType: EndpointCredentialType.Anonymous,
        username: '',
        password: ''
    }
};
