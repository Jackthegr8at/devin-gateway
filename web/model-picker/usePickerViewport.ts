import { useLayoutEffect, type RefObject } from "react";

/** Use page scrolling only when natural-height fixed controls leave no usable list space. */
export function usePickerViewport(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const picker = ref.current;
    if (!picker) return;
    const fixed = [...picker.querySelectorAll<HTMLElement>(
      ".picker-header, .picker-footer, .picker-body > :not(.edit-controls), " +
      ".edit-controls > :not(.model-browser), .model-browser > :not(.model-list)",
    )];
    const pixels = (value: string) => Number.parseFloat(value) || 0;
    const spacing = (element: HTMLElement) => {
      const css = getComputedStyle(element);
      return pixels(css.paddingTop) + pixels(css.paddingBottom) + pixels(css.borderTopWidth) + pixels(css.borderBottomWidth);
    };
    const measure = () => {
      const fixedHeight = fixed.reduce((total, element) => {
        const css = getComputedStyle(element);
        if (css.display === "none" || css.position === "absolute") return total;
        return total + element.getBoundingClientRect().height + pixels(css.marginTop) + pixels(css.marginBottom);
      }, 0);
      const containers = [...picker.querySelectorAll<HTMLElement>(".picker-body, .edit-controls, .model-browser")];
      const required = fixedHeight + containers.reduce((total, element) => total + spacing(element), spacing(picker)) + 64;
      const body = getComputedStyle(document.body);
      const available = window.innerHeight - pixels(body.paddingTop) - pixels(body.paddingBottom);
      picker.classList.toggle("page-scroll", required > available);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    for (const element of fixed) observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  });
}
