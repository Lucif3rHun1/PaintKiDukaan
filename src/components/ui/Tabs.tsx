"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "./cn"

// Legacy types for backward compat
interface TabItem<T extends string = string> {
  id: T
  label: string
  icon?: React.ComponentType<{ className?: string }>
  badge?: number | string
}

interface LegacyTabsProps<T extends string = string> {
  items: readonly TabItem<T>[]
  value: T
  onChange: (id: T) => void
  ariaLabel: string
  className?: string
}

// Legacy Tabs: old items/value/onChange API
function TabsLegacy<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
}: LegacyTabsProps<T>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      value={value}
      onValueChange={onChange as (val: string) => void}
      className={cn("group/tabs flex flex-col gap-2", className)}
    >
      <TabsPrimitive.List
        data-slot="tabs-list"
        className="group/tabs-list inline-flex h-11 w-fit items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground sm:h-10"
        aria-label={ariaLabel}
      >
        {items.map((item) => (
          <TabsPrimitive.Tab
            key={item.id}
            value={item.id}
            data-slot="tabs-trigger"
            className="relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 text-sm font-medium whitespace-nowrap text-foreground/60 outline-none transition-[color,background-color,transform,box-shadow] duration-fast ease-standard hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 data-active:bg-background data-active:text-foreground dark:text-muted-foreground dark:hover:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            {item.icon && <item.icon className="size-4" />}
            {item.label}
            {item.badge != null && (
              <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary/10 px-1.5 text-xs font-medium text-primary tabular-nums">
                {item.badge}
              </span>
            )}
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  )
}

// Composition API (new)
function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-1 text-muted-foreground group-data-horizontal/tabs:h-11 sm:group-data-horizontal/tabs:h-10 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 text-sm font-medium whitespace-nowrap text-foreground/60 outline-none transition-[color,background-color,transform,box-shadow] duration-fast ease-standard group-data-vertical/tabs:min-h-10 group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-sm group-data-[variant=line]/tabs-list:data-active:shadow-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:bg-transparent group-data-[variant=line]/tabs-list:data-active:bg-transparent dark:group-data-[variant=line]/tabs-list:data-active:border-transparent dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
        "data-active:bg-background data-active:text-foreground dark:data-active:border-input dark:data-active:bg-input/30 dark:data-active:text-foreground",
        "after:absolute after:scale-75 after:bg-foreground after:opacity-0 after:shadow-sm after:transition-[opacity,transform,box-shadow] after:duration-fast after:ease-standard motion-reduce:after:transition-none group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-horizontal/tabs:after:scale-y-100 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-vertical/tabs:after:scale-x-100 group-data-[variant=line]/tabs-list:data-active:after:scale-100 group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

// Export both legacy and composition APIs
const TabsExport = Object.assign(Tabs, {
  List: TabsList,
  Trigger: TabsTrigger,
  Content: TabsContent,
  Legacy: TabsLegacy,
})

export { TabsExport as Tabs, TabsLegacy, TabsList, TabsTrigger, TabsContent, tabsListVariants, type TabItem, type LegacyTabsProps }
export type TabsProps = TabsPrimitive.Root.Props
