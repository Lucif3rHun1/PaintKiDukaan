import { useEffect, useState } from "react";
import { Alert, Button, Card, Money, Skeleton } from "../../components/ui";
import { fetchCustomerLedger } from "./api";
import { extractError } from "../../lib/extractError";
import type { Customer, CustomerLedger } from "../types";
import { LedgerTable } from "./LedgerTable";

export { CustomerCreditInvoiceForm } from "./CreditInvoiceForm";

interface Props {
  customer: Customer;
  onCreateCreditInvoice: () => void;
}

export function CustomerLedgerView({ customer, onCreateCreditInvoice }: Props) {
  const [ledger, setLedger] = useState<CustomerLedger | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    fetchCustomerLedger(customer.id, 200)
      .then((d) => setLedger(d ?? null))
      .catch((e) => setError(extractError(e)));
  }

  useEffect(() => {
    load();
  }, [customer.id]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Ledger</h3>
        <Button
          type="button"
          onClick={onCreateCreditInvoice}
          size="sm"
        >
          Credit invoice
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-3">{error}</Alert>
      )}

      {!ledger ? (
        <Skeleton variant="card" />
      ) : (
        <>
          <Card depth="raised" className="mb-2 flex-row items-center justify-between p-3 text-xs text-muted-foreground">
            <span>
              Opening <Money paise={ledger.opening_balance_paise} />
            </span>
            <span>
              Closing <Money paise={ledger.closing_balance_paise} />
            </span>
          </Card>
          <LedgerTable rows={ledger.rows} />
        </>
      )}

    </div>
  );
}
