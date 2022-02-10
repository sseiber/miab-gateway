export enum SecurityMode {
    'Lowest',
    'Best'
}

export enum EndpointCredentialType {
    'Anonymous',
    'Username'
}

export interface EndpointCredentials {
    CredentialType: EndpointCredentialType;
    Username: string;
    Password: string;
}

export interface OpcEndpoint {
    Uri: string;
    SecurityMode: SecurityMode;
    Credentials: {
        CredentialType: EndpointCredentialType;
    };
}

export const emptyOpcCredential = {
    Uri: '',
    SecurityMode: SecurityMode.Lowest,
    Credentials: {
        CredentialType: EndpointCredentialType.Anonymous
    }
};

export interface IWriteNodesRequestParams {
    nodeId: string;
    value: any;
}

export interface IReadNodesRequestParams {
    nodeId: string;
}

export interface IBrowseNodesRequestParams {
    startNode: string;
    depth: number;
    requestedAttributes: string;
}

export interface OpcWriteNode {
    NodeId: string;
    DataValue: OpcDataValue;
}

export interface OpcDataValue {
    Status: string;
    Value: any;
    SourceTimestamp: Date;
    ServerTimestamp: Date;
}

export interface OpcReadNode {
    NodeId: string;
    DataValue: OpcDataValue;
}

export interface ReadValuesRequest {
    Endpoint: OpcEndpoint;
    OpcReadNodes: OpcReadNode[];
}
