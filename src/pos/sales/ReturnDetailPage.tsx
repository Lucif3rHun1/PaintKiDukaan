// Return detail page — read-only view of a past return.

import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Printer, RotateCcw } from "lucide-react";

import { Badge, Button, Card, EmptyState, Money } from "../../components/ui";
import { getSaleReturn } from "../../domain/ipc";
import type { SaleReturn } from "../../domain/types";
import { formatDateForDisplay } from "../../lib/date";
import { extractError } from "../../lib/extractError";
import { safePrintReturnById } from "./printOrDownload";
import { setHash } from "../../lib/navigate";
import { Skeleton } from "boneyard-js/react";

interface Props {
  id: number;
  onBack: () => void;
}

export function ReturnDetailPage({ id, onBack }: Props) {
  const [ret, setRet] = useState<SaleReturn | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRet(null);
    getSaleReturn(id)
      .then((match) => {
        if (cancelled) return;
        if (!match) {
          setError(`Return #${id} not found.`);
        }
        setRet(match);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(extractError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading return…
      </div>
    );
  }

  if (error || !ret) {
    return (
      <div className="space-y-4">
        <header className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
            Returns
          </Button>
        </header>
        <EmptyState
          icon={RotateCcw}
          title="Return not found"
          description={error ?? `Return #${id} could not be loaded.`}
          primary={
            <Button type="button" onClick={onBack}>
              Back to returns
            </Button>
          }
        />
      </div>
    );
  }

  const refunded = ret.payment_modes.reduce((sum, m) => sum + m.amount, 0);

  return (
  <Skeleton name="return-detail" loading={loading} select="viewport">
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>
            Returns
          </Button>
          <h1 className="text-base font-semibold text-foreground">
            Return <span className="font-mono tabular-nums">{ret.no}</span>
          </h1>
          <Badge variant="info" size="sm">return</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="md"
            icon={Printer}
            onClick={() => void safePrintReturnById(ret.id)}
          >
            Print
          </Button>
          {ret.sale_id > 0 ? (
            <Button
              type="button"
              variant="secondary"
              size="md"
              icon={ExternalLink}
              onClick={() => (setHash(`#/sales/${ret.sale_id}`))}
            >
              View original sale
            </Button>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <Card as="section" depth="flat" className="space-y-3 p-4">
          <h2 className="text-sm font-semibold text-foreground">Items</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2">Item</th>
                  <th>Qty</th>
                  <th>Refund</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {ret.lines.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                      No items in this return.
                    </td>
                  </tr>
                ) : ret.lines.map((line, index) => (
                  <tr key={`${line.sale_item_id}-${index}`} className="border-b border-border align-middle">
                    <td className="py-2">
                      <div className="text-sm font-medium text-foreground">{line.item_name}</div>
                      <div className="font-mono text-xs text-muted-foreground">#{line.sale_item_id}</div>
                    </td>
                    <td className="py-2 tabular-nums">{line.qty}</td>
                    <td className="py-2">
                      <Money paise={line.refund_paise} />
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {line.shade_note ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="space-y-4">
          <Card as="section" depth="flat" className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-foreground">Details</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Date</dt>
                <dd className="text-foreground">{formatDateForDisplay(ret.date)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">Created</dt>
                <dd className="text-foreground">{formatDateForDisplay(ret.created_at)}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">Reason</dt>
                <dd className="text-right text-foreground">
                  {ret.reason ?? <span className="text-muted-foreground">—</span>}
                </dd>
              </div>
              {ret.sale_id > 0 ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Original sale</dt>
                  <dd className="font-mono text-foreground">#{ret.sale_id}</dd>
                </div>
              ) : null}
            </dl>
          </Card>

          <Card as="section" depth="raised" className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-foreground">Refund breakdown</h2>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Total</span>
                <Money paise={ret.refund_total} className="text-foreground" />
              </div>
              {ret.payment_modes.map((m, index) => (
                <div key={`${m.mode}-${index}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground capitalize">{m.mode}</span>
                  <Money paise={m.amount} />
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-sm font-medium">
                <span className="text-foreground">Refunded</span>
                <Money paise={refunded} className="text-success" />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  </Skeleton>
  );
}
