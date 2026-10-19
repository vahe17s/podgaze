import type { PriceQuote, PriceRequest } from "@podgaze/contracts";

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type AzureItem = { retailPrice?: number; unitOfMeasure?: string; skuName?: string; productName?: string; type?: string };

const SAFE = /^[A-Za-z0-9_-]+$/;

// Picks the pay-as-you-go Linux price (or the Spot one) out of everything Azure lists for a VM size.
export function azureHourly(items: AzureItem[], spot: boolean): number | null {
  const prices = items
    .filter((item) => item.type === "Consumption" && item.unitOfMeasure === "1 Hour" && typeof item.retailPrice === "number")
    .filter((item) => !/Windows/i.test(item.productName ?? ""))
    .filter((item) => (spot ? /Spot/i.test(item.skuName ?? "") : !/Spot|Low Priority/i.test(item.skuName ?? "")))
    .map((item) => item.retailPrice!)
    .filter((price) => price > 0);
  return prices.length > 0 ? Math.min(...prices) : null;
}

export function createPriceLookup(fetchJson: Fetch) {
  return async function lookupPrices(requests: PriceRequest[]): Promise<PriceQuote[]> {
    return Promise.all(requests.slice(0, 40).map(async (request): Promise<PriceQuote> => {
      if (!request.instanceType.startsWith("Standard_")) return { ...request, hourly: null, note: "Only Azure VM sizes can be looked up; enter this one by hand." };
      if (!SAFE.test(request.instanceType) || !SAFE.test(request.region)) return { ...request, hourly: null, note: "Unexpected instance type or region." };
      const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${request.region}' and armSkuName eq '${request.instanceType}' and priceType eq 'Consumption'`;
      try {
        const response = await fetchJson(`https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`);
        if (!response.ok) return { ...request, hourly: null, note: `Azure price list answered ${response.status}.` };
        const body = (await response.json()) as { Items?: AzureItem[] };
        const hourly = azureHourly(body.Items ?? [], request.spot);
        return { ...request, hourly, note: hourly === null ? "Azure lists no price for this size here." : "Azure retail, pay-as-you-go, USD" };
      } catch (error) {
        return { ...request, hourly: null, note: `Could not reach the Azure price list: ${error instanceof Error ? error.message : "network error"}.` };
      }
    }));
  };
}
