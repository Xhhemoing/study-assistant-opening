"use client";

import * as TabsPrimitive from "@radix-ui/react-tabs";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { focusRing } from "./styles";

export const Tabs = TabsPrimitive.Root;
export const TabsList = forwardRef<ComponentRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(function TabsList({ className = "", ...props }, ref) {
  return <TabsPrimitive.List ref={ref} className={`flex min-h-11 gap-1 overflow-x-auto border-b border-line ${className}`} {...props} />;
});
export const TabsTrigger = forwardRef<ComponentRef<typeof TabsPrimitive.Trigger>, ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>>(function TabsTrigger({ className = "", ...props }, ref) {
  return <TabsPrimitive.Trigger ref={ref} className={`min-h-11 shrink-0 border-b-2 border-transparent px-4 text-sm text-text-2 transition-colors duration-200 hover:text-text data-[state=active]:border-ink data-[state=active]:font-medium data-[state=active]:text-text disabled:opacity-50 motion-reduce:transition-none ${focusRing} ${className}`} {...props} />;
});
export const TabsContent = forwardRef<ComponentRef<typeof TabsPrimitive.Content>, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(function TabsContent({ className = "", ...props }, ref) {
  // forceMount callers retain state without exposing inactive controls to Tab/AT.
  return <TabsPrimitive.Content ref={ref} className={`min-w-0 py-4 data-[state=inactive]:hidden ${focusRing} ${className}`} {...props} />;
});
