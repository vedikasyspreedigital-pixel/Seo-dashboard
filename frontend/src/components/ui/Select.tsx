import { useEffect, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  /** Renders a filter input at the top of the open listbox, substring-matched
   * against option labels (same case-insensitive approach as ClientsPage's
   * existing search). Off by default -- only the client switcher needs it
   * today; every other Select usage is unaffected. */
  searchable?: boolean;
}

/**
 * A minimal styled listbox -- native <select> popups can't be themed (they
 * render via the OS/browser, not our CSS), which is why the dropdown looked
 * out of place against the dark UI. No virtualization/multi-select, just
 * enough for this app's client picker: click or Enter/Space to open,
 * arrow keys to move, Escape or an outside click to close.
 */
export function Select({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  searchable = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);
  const filteredOptions = searchable && query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node))
        setOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function openMenu() {
    if (disabled) return;
    const currentIndex = options.findIndex((o) => o.value === value);
    setHighlighted(currentIndex >= 0 ? currentIndex : 0);
    setQuery("");
    setOpen(true);
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent) {
    if (
      event.key === "ArrowDown" ||
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      openMenu();
    }
  }

  function handleMenuKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((i) => Math.min(i + 1, filteredOptions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = filteredOptions[highlighted];
      if (option) {
        onChange(option.value);
        setOpen(false);
      }
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3.5 py-2.5 text-left text-sm text-[var(--color-ink)] shadow-sm transition-colors focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-400/25 disabled:opacity-50"
      >
        <span className={selected ? "" : "text-[var(--color-ink-faint)]"}>
          {selected ? selected.label : placeholder}
        </span>
        <svg
          viewBox="0 0 20 20"
          fill="none"
          className={`h-4 w-4 shrink-0 text-[var(--color-ink-faint)] transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M5 7.5L10 12.5L15 7.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          className="absolute z-20 mt-2 w-full overflow-hidden rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
        >
          {searchable && (
            <div className="border-b border-[var(--color-border)] p-1.5">
              <input
                ref={(el) => {
                  searchInputRef.current = el;
                  el?.focus();
                }}
                type="text"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlighted(0);
                }}
                onKeyDown={handleMenuKeyDown}
                placeholder="Search..."
                className="w-full rounded-lg bg-transparent px-2 py-1.5 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-faint)] focus:outline-none"
              />
            </div>
          )}
          <ul
            role="listbox"
            tabIndex={-1}
            onKeyDown={searchable ? undefined : handleMenuKeyDown}
            className="scrollbar-hidden max-h-64 overflow-auto p-1.5 focus:outline-none"
            ref={(el) => {
              if (!searchable) el?.focus();
            }}
          >
            {filteredOptions.length === 0 ? (
              <li className="px-3 py-2 text-sm text-[var(--color-ink-faint)]">No matches</li>
            ) : (
              filteredOptions.map((option, index) => (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${
                    index === highlighted
                      ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                      : "text-[var(--color-ink-muted)]"
                  } ${option.value === value ? "font-semibold text-brand-300" : ""}`}
                >
                  {option.label}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
