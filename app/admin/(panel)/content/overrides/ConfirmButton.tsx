"use client";

/** A submit button that asks first (resets cannot be undone from here). */
export default function ConfirmButton({
  label,
  prompt,
  className,
}: {
  label: string;
  prompt: string;
  className: string;
}) {
  return (
    <button
      type="submit"
      onClick={(event) => {
        if (!window.confirm(prompt)) event.preventDefault();
      }}
      className={className}
    >
      {label}
    </button>
  );
}
