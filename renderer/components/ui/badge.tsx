import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-[var(--aperture)]/10 text-[var(--aperture)] border border-[var(--aperture)]/20",
        secondary: "bg-[var(--chassis)] text-[var(--flare)]",
        outline: "border border-[var(--chassis)] text-[var(--flare)]",
        muted: "bg-[var(--void)] text-[var(--etch)] border border-[var(--chassis)]",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
