import { TriangleAlert } from "lucide-react";
import { Badge } from "./Badge";

export function StockStatusBadge({
  qty,
  reorderLevel,
}: {
  qty: number;
  reorderLevel?: number | null;
}) {
  if (qty <= 0) {
    return (
      <Badge variant="danger" size="sm">
        <TriangleAlert aria-hidden="true" />
        Out of stock
      </Badge>
    );
  }
  if (reorderLevel != null && qty <= reorderLevel) {
    return (
      <Badge variant="warning" size="sm">
        <TriangleAlert aria-hidden="true" />
        Low · {qty}
      </Badge>
    );
  }
  return (
    <Badge variant="success" size="sm">
      {qty} in stock
    </Badge>
  );
}
