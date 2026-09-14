import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listCustomers,
  requirePortalAccessToken,
  type CustomerSummary,
} from "../../../../lib/omniflow/portal";
import CustomersClient from "./CustomersClient";


export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getOmniFlowSession();
  const params = await searchParams;
  const rawQuery = params.q;
  const initialQuery = typeof rawQuery === "string" ? rawQuery.slice(0, 100) : "";

  let initialCustomers: CustomerSummary[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const customers = await listCustomers(accessToken, initialQuery || undefined);
      if (customers) initialCustomers = customers;
    }
  }

  return (
    <CustomersClient initialCustomers={initialCustomers} initialQuery={initialQuery} />
  );
}
