import type { ReactNode } from "react";
import { type Role, useSecurity } from "./state";

const ROLE_HIERARCHY: Record<Role, number> = {
  stocker: 0,
  cashier: 1,
  owner: 2,
};

interface RoleGuardProps {
  minRole: Role;
  children: ReactNode;
  fallback?: ReactNode;
}

export function RoleGuard({ minRole, children, fallback = null }: RoleGuardProps) {
  const currentRole = useSecurity((s) => s.session.user?.role ?? "owner");
  const currentLevel = ROLE_HIERARCHY[currentRole] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[minRole] ?? 0;

  if (currentLevel >= requiredLevel) return <>{children}</>;
  return <>{fallback}</>;
}
