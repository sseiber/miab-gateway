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

export interface OpcuaEndpoint {
    Uri: string;
    SecurityMode: SecurityMode;
    Credentials: {
        CredentialType: EndpointCredentialType;
    };
}

export const emptyOpcuaCredential = {
    Uri: '',
    SecurityMode: SecurityMode.Lowest,
    Credentials: {
        CredentialType: EndpointCredentialType.Anonymous
    }
};

export interface IBrowseNodesRequestParams {
    StartNode: string;
    Depth: number;
    RequestedAttributes: string;
}
