import * as React from "react"

import { cn } from "@/lib/utils"

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg border border-border bg-card text-card-foreground shadow-sm",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6", className)}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

type CardTitleProps = React.HTMLAttributes<HTMLHeadingElement> & {
  /**
   * Heading level to render. Defaults to 2 so card titles remain part of the
   * document outline. Use a lower level (e.g. 3) when nesting cards.
   */
  as?: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
}

const CardTitle = React.forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ className, as: Heading = "h2", ...props }, ref) => (
    <Heading
      ref={ref}
      className={cn(
        "text-2xl font-semibold leading-none tracking-tight",
        className
      )}
      {...props}
    />
  )
)
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0", className)}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export type CardTableColumn<T> = {
  /** Stable key used for React keys and the card-equivalent labels. */
  key: string
  /** Visible column header text. */
  header: React.ReactNode
  /** Renders the cell content for a given row. */
  cell: (row: T) => React.ReactNode
  /** Optional label used on narrow viewports; falls back to `header`. */
  mobileLabel?: React.ReactNode
  /** Hide this column from the narrow card presentation. */
  hideOnMobile?: boolean
  /** Extra classes applied to both the th/td and the mobile value. */
  className?: string
}

export type CardTableProps<T> = {
  /** Column definitions shared by the table and card presentations. */
  columns: CardTableColumn<T>[]
  /** Row data. */
  data: T[]
  /** Returns a stable key for a row. */
  getRowKey: (row: T, index: number) => React.Key
  /** Accessible caption describing the table contents. */
  caption?: React.ReactNode
  /** Message shown when there are no rows. */
  emptyMessage?: React.ReactNode
  /** Optional per-row class name. */
  rowClassName?: (row: T, index: number) => string | undefined
  className?: string
}

/**
 * Renders a semantic table on wide viewports and an equivalent definition-list
 * card layout on narrow viewports. Only one presentation is exposed to
 * assistive technology at a time so screen readers never announce duplicates.
 */
function CardTable<T>({
  columns,
  data,
  getRowKey,
  caption,
  emptyMessage = "No records found.",
  rowClassName,
  className,
}: CardTableProps<T>) {
  const mobileColumns = columns.filter((column) => !column.hideOnMobile)

  if (data.length === 0) {
    return (
      <div
        className={cn(
          "rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground",
          className
        )}
        role="status"
      >
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className={className}>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-sm">
          {caption ? (
            <caption className="sr-only">{caption}</caption>
          ) : null}
          <thead>
            <tr className="border-b border-border text-left">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cn(
                    "whitespace-nowrap px-3 py-2 font-medium text-muted-foreground",
                    column.className
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, index) => (
              <tr
                key={getRowKey(row, index)}
                className={cn(
                  "border-b border-border last:border-0",
                  rowClassName?.(row, index)
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cn("px-3 py-2 align-top", column.className)}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden" aria-label={typeof caption === "string" ? caption : undefined}>
        {data.map((row, index) => (
          <li
            key={getRowKey(row, index)}
            className={cn(
              "rounded-md border border-border p-4",
              rowClassName?.(row, index)
            )}
          >
            <dl className="space-y-2">
              {mobileColumns.map((column) => (
                <div key={column.key} className="flex flex-col gap-0.5">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {column.mobileLabel ?? column.header}
                  </dt>
                  <dd className={cn("text-sm", column.className)}>
                    {column.cell(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  )
}

export type CardStatusProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Visual tone of the status message. */
  tone?: "info" | "success" | "error"
  /** Politeness of the live region. Errors default to assertive. */
  politeness?: "polite" | "assertive"
}

const statusToneClasses: Record<NonNullable<CardStatusProps["tone"]>, string> = {
  info: "border-border bg-muted text-foreground",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
}

/**
 * Live region for announcing admin action status and error changes.
 * Renders nothing visible when there is no message but keeps the region
 * mounted so updates are reliably announced by assistive technology.
 */
const CardStatus = React.forwardRef<HTMLDivElement, CardStatusProps>(
  ({ className, tone = "info", politeness, children, ...props }, ref) => {
    const isError = tone === "error"
    return (
      <div
        ref={ref}
        role={isError ? "alert" : "status"}
        aria-live={politeness ?? (isError ? "assertive" : "polite")}
        aria-atomic="true"
        className={cn(
          "rounded-md border px-3 py-2 text-sm",
          statusToneClasses[tone],
          !children && "sr-only",
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }
)
CardStatus.displayName = "CardStatus"

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  CardTable,
  CardStatus,
}
