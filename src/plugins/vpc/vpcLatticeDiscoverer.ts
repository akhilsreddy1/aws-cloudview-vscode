import { ListServiceNetworksCommand, ListServicesCommand } from "@aws-sdk/client-vpc-lattice";
import type { ResourceDiscoverer, ResourceNode, DiscoveryContext } from "../../core/contracts";
import type { ResourceRegistry } from "../../registry/resourceRegistry";
import { ResourceTypes } from "../../core/resourceTypes";
import { buildVpcLatticeArn } from "../../core/resourceUtils";
import { shouldStopPagination } from "../../core/pagination";

const serviceNetworkDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.vpcLattice(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("vpc-lattice", "ListServiceNetworks", () =>
        client.send(new ListServiceNetworksCommand({ nextToken: nextToken, maxResults: 100 }))
      );

      for (const sn of response.items ?? []) {
        const id = sn.id!;
        const arn = sn.arn ?? buildVpcLatticeArn(scope.region, scope.accountId, "servicenetwork", id);
        const name = sn.name ?? id;

        resources.push({
          arn,
          id,
          type: ResourceTypes.vpcLatticeServiceNetwork,
          service: "vpc",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags: {},
          rawJson: sn as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.nextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "vpc-lattice:ListServiceNetworks",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

const latticeServiceDiscoverer: ResourceDiscoverer = {
  async discover(context: DiscoveryContext): Promise<ResourceNode[]> {
    const { scope, platform } = context;
    const client = await platform.awsClientFactory.vpcLattice(scope);
    const resources: ResourceNode[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const response = await platform.scheduler.run("vpc-lattice", "ListServices", () =>
        client.send(new ListServicesCommand({ nextToken: nextToken, maxResults: 100 }))
      );

      for (const svc of response.items ?? []) {
        const id = svc.id!;
        const arn = svc.arn ?? buildVpcLatticeArn(scope.region, scope.accountId, "service", id);
        const name = svc.name ?? id;

        resources.push({
          arn,
          id,
          type: ResourceTypes.vpcLatticeService,
          service: "vpc",
          accountId: scope.accountId,
          region: scope.region,
          name,
          tags: {},
          rawJson: svc as Record<string, unknown>,
          lastUpdated: Date.now(),
        });
      }

      nextToken = response.nextToken;
      pages++;
      if (shouldStopPagination({
        pages, nextToken, label: "vpc-lattice:ListServices",
        logger: platform.logger, cancellation: context.cancellation,
      })) break;
    } while (nextToken);

    return resources;
  },
};

export function registerVpcLatticePlugins(registry: ResourceRegistry): void {
  registry.register({
    type: ResourceTypes.vpcLatticeServiceNetwork,
    service: "vpc",
    serviceLabel: "VPC",
    displayName: "VPC Lattice service network",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: serviceNetworkDiscoverer,
    detailFields: [
      { label: "Service network ID", path: "id", source: "resource" },
      { label: "Name", path: "name", source: "raw" },
      { label: "Associated VPCs", path: "numberOfAssociatedVPCs", source: "raw" },
      { label: "Associated services", path: "numberOfAssociatedServices", source: "raw" },
    ],
  });

  registry.register({
    type: ResourceTypes.vpcLatticeService,
    service: "vpc",
    serviceLabel: "VPC",
    displayName: "VPC Lattice service",
    scope: "regional",
    ttlSeconds: 300,
    discoverer: latticeServiceDiscoverer,
    detailFields: [
      { label: "Service ID", path: "id", source: "resource" },
      { label: "Name", path: "name", source: "raw" },
      { label: "Status", path: "status", source: "raw" },
      { label: "DNS name", path: "dnsEntry.domainName", source: "raw" },
    ],
  });
}
