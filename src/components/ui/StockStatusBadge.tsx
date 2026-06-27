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
        <TriangleAlert className="mr-1 h-3 w-3" />
        Out of stock
      </Badge>
    );
  }
  if (reorderLevel != null && qty <= reorderLevel) {
    return (
      <Badge variant="warning" size="sm">
        <TriangleAlert className="mr-1 h-3 w-3" />
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
