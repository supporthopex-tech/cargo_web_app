import type { PermissionMode, UserRole } from "../types"

export const PERMISSIONS = [
  "dashboard.view",
  "shipments.view", "shipments.create", "shipments.edit", "shipments.delete", "shipments.update_status", "shipments.extra_charges",
  "customers.view", "customers.create", "customers.edit", "customers.delete",
  "packing.view", "packing.create", "packing.edit",
  "quotes.view", "quotes.create", "quotes.edit",
  "invoices.view", "invoices.create", "invoices.edit",
  "payments.view", "payments.create",
  "accounting.view", "accounting.create", "accounting.edit",
  "reports.view", "reports.export",
  "expenses.view", "expenses.create", "expenses.edit", "expenses.delete",
  "staff.view", "staff.create", "staff.edit", "staff.disable", "staff.permissions",
  "settings.view", "settings.edit",
] as const

export type PermissionCode = (typeof PERMISSIONS)[number]

export const PERMISSION_LABELS: Record<PermissionCode, string> = {
  "dashboard.view": "View dashboard",
  "shipments.view": "View shipments",
  "shipments.create": "Create shipments",
  "shipments.edit": "Edit shipments",
  "shipments.delete": "Delete shipments",
  "shipments.update_status": "Update shipment status",
  "shipments.extra_charges": "Add or change cargo extra charges",
  "customers.view": "View customers",
  "customers.create": "Create customers",
  "customers.edit": "Edit customers",
  "customers.delete": "Delete customers",
  "packing.view": "View packing lists",
  "packing.create": "Create packing lists",
  "packing.edit": "Edit packing lists",
  "quotes.view": "View quotes",
  "quotes.create": "Create quotes",
  "quotes.edit": "Edit quotes",
  "invoices.view": "View invoices",
  "invoices.create": "Create invoices",
  "invoices.edit": "Edit invoices",
  "payments.view": "View payments",
  "payments.create": "Create payments",
  "accounting.view": "View accounting",
  "accounting.create": "Create accounting entries",
  "accounting.edit": "Edit accounting entries",
  "reports.view": "View reports",
  "reports.export": "Export reports",
  "expenses.view": "View expenses",
  "expenses.create": "Create expenses",
  "expenses.edit": "Edit expenses",
  "expenses.delete": "Delete expenses",
  "staff.view": "View staff",
  "staff.create": "Create staff",
  "staff.edit": "Edit staff",
  "staff.disable": "Enable or disable staff",
  "staff.permissions": "Assign staff permissions",
  "settings.view": "View company settings",
  "settings.edit": "Edit company settings",
}

export const ROLE_LABELS: Record<UserRole, string> = {
  Admin: "Admin",
  Manager: "Manager",
  Staff: "Staff",
  Accountant: "Accountant",
}

const managerPermissions: PermissionCode[] = [
  "dashboard.view",
  "shipments.view", "shipments.create", "shipments.edit", "shipments.update_status", "shipments.extra_charges",
  "customers.view", "customers.create", "customers.edit",
  "packing.view", "packing.create", "packing.edit",
  "quotes.view", "quotes.create", "quotes.edit",
  "invoices.view", "invoices.create", "invoices.edit",
  "payments.view", "payments.create",
  "reports.view",
  "expenses.view", "expenses.create", "expenses.edit",
]

const staffPermissions: PermissionCode[] = [
  "dashboard.view",
  "shipments.view", "shipments.create", "shipments.edit", "shipments.update_status",
  "customers.view", "customers.create", "customers.edit",
  "packing.view", "packing.create", "packing.edit",
  "quotes.view", "quotes.create",
  "invoices.view", "invoices.create",
  "payments.view", "payments.create",
]

const accountantPermissions: PermissionCode[] = [
  "dashboard.view",
  "invoices.view", "invoices.create", "invoices.edit",
  "payments.view", "payments.create",
  "accounting.view", "accounting.create", "accounting.edit",
  "reports.view", "reports.export",
  "expenses.view", "expenses.create", "expenses.edit",
]

export const ROLE_PERMISSIONS: Record<UserRole, readonly PermissionCode[]> = {
  Admin: PERMISSIONS,
  Manager: managerPermissions,
  Staff: staffPermissions,
  Accountant: accountantPermissions,
}

export function isPermissionCode(value: string): value is PermissionCode {
  return (PERMISSIONS as readonly string[]).includes(value)
}

export function effectivePermissions(
  role: UserRole | undefined,
  mode: PermissionMode = "ROLE_DEFAULT",
  customPermissions: readonly string[] = [],
): readonly PermissionCode[] {
  if (!role) return []
  if (role === "Admin") return PERMISSIONS
  if (mode === "CUSTOM") return customPermissions.filter(isPermissionCode)
  return ROLE_PERMISSIONS[role]
}

export function hasPermission(
  role: UserRole | undefined,
  permission: PermissionCode,
  mode: PermissionMode = "ROLE_DEFAULT",
  customPermissions: readonly string[] = [],
): boolean {
  return effectivePermissions(role, mode, customPermissions).includes(permission)
}
