import { useCallback, useEffect, useRef, useState, isValidElement } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { cn } from "./cn";

interface Action {
  label: string;
  icon?: React.ComponentType<{ className?: string }> | React.ReactNode;
  onSelect?: () => void;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  label?: string;
  /** Primary API — prefer this. Each action's `onSelect` fires on click/Enter. */
  actions?: Action[];
  /** Alias for `actions`. Accepts the same shape; use whichever your callers already pass. */
  items?: Action[];
  className?: string;
}

function isIconComponent(
  icon: React.ComponentType<{ className?: string }> | React.ReactNode,
): icon is React.ComponentType<{ className?: string }> {
  return (
    typeof icon === "function" ||
    (typeof icon === "object" &&
      icon !== null &&
      !isValidElement(icon))
  );
}

interface MenuPos {
  top: number;
  left: number;
  placement: "bottom-left" | "bottom-right" | "top-left" | "top-right";
}

const MENU_WIDTH = 192; // w-48
const MENU_ITEM_PX = 40;
const MENU_VPAD = 8;
const VIEWPORT_GUTTER = 8;
const CLOSE_DELAY_MS = 120;
const MENU_CLOSED_OFFSET: Record<MenuPos["placement"], string> = {
  "bottom-left": "-translate-y-0.5",
  "bottom-right": "-translate-y-0.5",
  "top-left": "translate-y-0.5",
  "top-right": "translate-y-0.5",
};

// allow: SIZE_OK — positioning, dismissal, and keyboard state must remain one menu state machine.
export function ActionMenu({ label, actions, items, className }: Props) {
  const [open, setOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const enterFrameRef = useRef<number | null>(null);
  const [pos, setPos] = useState<MenuPos>({
    top: 0,
    left: 0,
    placement: "bottom-right",
  });

  const visibleActions = items ?? actions ?? [];
  const enabledActions = visibleActions.filter((action) => !action.disabled);

  const closeMenu = useCallback(() => {
    if (!open) return;
    if (enterFrameRef.current !== null) {
      window.cancelAnimationFrame(enterFrameRef.current);
      enterFrameRef.current = null;
    }
    setOpen(false);
    setIsVisible(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setIsClosing(false);
      return;
    }
    setIsClosing(true);
  }, [open]);

  function openMenu() {
    if (enterFrameRef.current !== null) {
      window.cancelAnimationFrame(enterFrameRef.current);
    }
    setOpen(true);
    setIsClosing(false);
    setIsVisible(false);
    enterFrameRef.current = window.requestAnimationFrame(() => {
      setIsVisible(true);
      enterFrameRef.current = null;
    });
  }

  function closeOnBlur(event: React.FocusEvent<HTMLElement>) {
    const next = event.relatedTarget;
    if (
      next instanceof Node &&
      (triggerRef.current?.contains(next) || menuRef.current?.contains(next))
    ) {
      return;
    }
    closeMenu();
  }

  useEffect(
    () => () => {
      if (enterFrameRef.current !== null) {
        window.cancelAnimationFrame(enterFrameRef.current);
      }
    },
    [],
  );

  // Position the portal-rendered menu relative to the trigger, flipping up if
  // it would overflow the bottom of the viewport. Recomputed when the menu
  // opens or its content changes. Scroll/resize closes the menu so it never
  // dangles from a stale anchor.
  useEffect(() => {
    if (!open) return;
    function compute() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const menuHeight = Math.min(
        visibleActions.length * MENU_ITEM_PX + MENU_VPAD,
        240,
      );
      const wouldOverflowBottom =
        rect.bottom + menuHeight > window.innerHeight - VIEWPORT_GUTTER;
      const placement: MenuPos["placement"] = wouldOverflowBottom
        ? "top-right"
        : "bottom-right";
      const top =
        placement === "bottom-right"
          ? rect.bottom + 4
          : rect.top - menuHeight - 4;
      const left = Math.max(
        VIEWPORT_GUTTER,
        Math.min(
          window.innerWidth - MENU_WIDTH - VIEWPORT_GUTTER,
          rect.right - MENU_WIDTH,
        ),
      );
      setPos({ top, left, placement });
    }
    compute();
    function dismissOnScroll() {
      closeMenu();
    }
    window.addEventListener("scroll", dismissOnScroll, true);
    window.addEventListener("resize", dismissOnScroll);
    return () => {
      window.removeEventListener("scroll", dismissOnScroll, true);
      window.removeEventListener("resize", dismissOnScroll);
    };
  }, [open, visibleActions.length, closeMenu]);

  // Keyboard navigation while the menu is open.
  useEffect(() => {
    if (!open) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        triggerRef.current?.focus();
        return;
      }
      if (enabledActions.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % enabledActions.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + enabledActions.length) % enabledActions.length);
      }
      if (e.key === "Enter" && enabledActions[activeIndex]) {
        e.preventDefault();
        const action = enabledActions[activeIndex];
        action.onSelect?.();
        action.onClick?.();
        closeMenu();
        triggerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, activeIndex, enabledActions, closeMenu]);

  useEffect(() => {
    if (open) setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (!isClosing) return;
    const timeout = window.setTimeout(() => setIsClosing(false), CLOSE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [isClosing]);

  // Outside-click dismiss. With a portal-rendered menu, both refs must be
  // checked — the trigger and the menu are siblings in the DOM, not parent/child.
  useEffect(() => {
    if (!open) return;
    function outside(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      closeMenu();
    }
    window.addEventListener("mousedown", outside);
    return () => window.removeEventListener("mousedown", outside);
  }, [open, closeMenu]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (open) closeMenu();
          else openMenu();
        }}
        onBlur={closeOnBlur}
        className={cn(
          "inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground outline-none transition-[color,background-color,transform] duration-fast ease-standard hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.98] motion-reduce:transform-none motion-reduce:transition-none",
          className,
        )}
        aria-label={label ?? "Actions"}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
      {(open || isClosing) &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-placement={pos.placement}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              width: MENU_WIDTH,
            }}
            onBlur={closeOnBlur}
            onTransitionEnd={(event) => {
              if (
                isClosing &&
                event.target === event.currentTarget &&
                event.propertyName === "opacity"
              ) {
                setIsClosing(false);
              }
            }}
            className={cn(
              "surface-overlay z-50 max-h-60 overflow-auto rounded-lg border border-border text-foreground shadow-overlay transition-[opacity,transform] duration-fast motion-reduce:translate-y-0 motion-reduce:transition-none motion-reduce:opacity-100",
              isVisible
                ? "translate-y-0 opacity-100 ease-enter"
                : cn(MENU_CLOSED_OFFSET[pos.placement], "opacity-0 ease-exit"),
            )}
          >
            {visibleActions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No actions</div>
            ) : (
              visibleActions.map((action) => {
                const enabledIndex = enabledActions.indexOf(action);
                return (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  className={cn(
                    "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
                    action.danger
                      ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
                      : "text-foreground hover:bg-muted focus-visible:bg-muted",
                    enabledIndex === activeIndex &&
                      (action.danger
                        ? "bg-destructive/10"
                        : "bg-muted"),
                  )}
                  disabled={action.disabled}
                  onMouseEnter={() => {
                    if (enabledIndex >= 0) setActiveIndex(enabledIndex);
                  }}
                  onClick={() => {
                    action.onSelect?.();
                    action.onClick?.();
                    closeMenu();
                    triggerRef.current?.focus();
                  }}
                >
                  {action.icon && (
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                      {isIconComponent(action.icon) ? (
                        <action.icon className="h-4 w-4" />
                      ) : (
                        action.icon
                      )}
                    </span>
                  )}
                  {action.label}
                </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
