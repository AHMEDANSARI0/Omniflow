import { getOmniFlowSession } from "../../../../lib/omniflow/auth-dal";
import {
  listCustomers,
  requirePortalAccessToken,
  type CustomerSummary,
} from "../../../../lib/omniflow/portal";
import CustomersClient from "./CustomersClient";


export default async function CustomersPage() {
  const session = await getOmniFlowSession();

  let initialCustomers: CustomerSummary[] | null = null;
  if (session.kind === "authenticated") {
    const accessToken = await requirePortalAccessToken();
    if (accessToken) {
      const customers = await listCustomers(accessToken);
      if (customers) initialCustomers = customers;
    }
  }

  return <CustomersClient initialCustomers={initialCustomers} />;
}
