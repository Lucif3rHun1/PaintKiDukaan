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
const MENU_ITEM_PX = 36;
const MENU_VPAD = 8;
const VIEWPORT_GUTTER = 8;
const MENU_ORIGIN: Record<MenuPos["placement"], string> = {
  "bottom-left": "origin-top-left",
  "bottom-right": "origin-top-right",
  "top-left": "origin-bottom-left",
  "top-right": "origin-bottom-right",
};

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

  const allActions = (items ?? actions ?? []).filter((a) => !a.disabled);

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
        allActions.length * MENU_ITEM_PX + MENU_VPAD,
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
  }, [open, allActions.length, closeMenu]);

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
      if (allActions.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % allActions.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + allActions.length) % allActions.length);
      }
      if (e.key === "Enter" && allActions[activeIndex]) {
        e.preventDefault();
        const action = allActions[activeIndex];
        action.onSelect?.();
        action.onClick?.();
        closeMenu();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, activeIndex, allActions, closeMenu]);

  useEffect(() => {
    if (open) setActiveIndex(0);
  }, [open]);

  // Outside-click dismiss. With a portal-rendered menu, both refs must be
  // checked — the trigger and the menu are siblings in the DOM, not parent/child.
  useEffect(() => {
    if (!open) return;
    function outside(e: MouseEvent) {
      const target = e.target as Node;
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
          "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
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
              "z-[1000] max-h-60 overflow-auto rounded-lg border border-border bg-card text-foreground shadow-xl ring-1 ring-black/5 transition-[opacity,transform] duration-fast ease-out will-change-transform motion-reduce:transition-none motion-reduce:opacity-100 motion-reduce:scale-100",
              MENU_ORIGIN[pos.placement],
              isVisible ? "scale-100 opacity-100" : "scale-[0.97] opacity-0",
            )}
          >
            {allActions.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No actions</div>
            ) : (
              allActions.map((action, i) => (
                <button
                  key={action.label}
                  type="button"
                  role="menuitem"
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                    action.danger
                      ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
                      : "text-foreground hover:bg-muted focus-visible:bg-muted",
                    i === activeIndex &&
                      (action.danger
                        ? "bg-destructive/10"
                        : "bg-muted"),
                  )}
                  onMouseEnter={() => setActiveIndex(i)}
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
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
