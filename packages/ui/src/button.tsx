import { forwardRef, type ButtonHTMLAttributes } from "react";
import { ui } from "./styles";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  /** All sizes retain a 44px target; compact reduces horizontal padding only. */
  size?: "default" | "compact" | "icon";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "default", type = "button", className = "", ...props },
  ref,
) {
  const sizing = size === "icon" ? "size-11 p-0" : size === "compact" && variant !== "primary" ? "px-2 text-xs" : "";
  return <button ref={ref} type={type} className={`${ui[variant]} ${sizing} ${className}`} {...props} />;
});
