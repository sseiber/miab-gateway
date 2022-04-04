import { HapiPlugin, inject } from 'spryly';
import { Server } from '@hapi/hapi';
import {
    IIotCentralPluginModuleOptions,
    iotCentralPluginModule
} from './iotCentralModule';
import {
    IndustrialConnectProxyGatewayService
} from '../services/industrialConnectProxyGateway';

const ModuleName = 'IndustrialConnectProxyGatewayPluginModule';

export class IndustrialConnectProxyGatewayPlugin implements HapiPlugin {
    @inject('$server')
    private server: Server;

    @inject('industrialConnectProxyGateway')
    private industrialConnectProxyGateway: IndustrialConnectProxyGatewayService;

    public async init(): Promise<void> {
        this.server.log([ModuleName, 'info'], `init`);
    }

    // @ts-ignore (options)
    public async register(server: Server, options: any): Promise<void> {
        server.log([ModuleName, 'info'], 'register');

        try {
            const pluginOptions: IIotCentralPluginModuleOptions = {
                initializeModule: this.industrialConnectProxyGateway.initializeModule.bind(this.industrialConnectProxyGateway),
                onHandleModuleProperties: this.industrialConnectProxyGateway.onHandleModuleProperties.bind(this.industrialConnectProxyGateway),
                onModuleClientError: this.industrialConnectProxyGateway.onModuleClientError.bind(this.industrialConnectProxyGateway),
                onModuleReady: this.industrialConnectProxyGateway.onModuleReady.bind(this.industrialConnectProxyGateway),
                onHealth: this.industrialConnectProxyGateway.onHealth.bind(this.industrialConnectProxyGateway)
            };

            await server.register([
                {
                    plugin: iotCentralPluginModule,
                    options: pluginOptions
                }
            ]);
        }
        catch (ex) {
            server.log([ModuleName, 'error'], `Error while registering : ${ex.message}`);
        }
    }
}
