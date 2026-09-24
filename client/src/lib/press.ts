/** Everything that looks like a button, including links styled as one. */
const PRESSABLE_SELECTOR = 'button:not(:disabled), [role="button"], a.action-btn, a.video-action-link, a[data-pressable]';

/** How far a pressed element shrinks, in pixels of its width, and the cap for very small elements. */
const PRESS_DEPTH_PX = 5;
const MAX_SHRINK = 0.08;

function play(element: HTMLElement): void {
  const shrink = Math.min(MAX_SHRINK, PRESS_DEPTH_PX / Math.max(element.offsetWidth, 1));
  element.style.setProperty('--press-scale', String(1 - shrink));

  // Restart the animation if the element is pressed again while it is still running.
  element.removeAttribute('data-pressed');
  void element.offsetWidth;
  element.setAttribute('data-pressed', '');
}

function pressableFrom(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(PRESSABLE_SELECTOR) : null;
}

/**
 * Plays the press animation from `app.css` on buttons. CSS `:active` alone is too short-lived on a quick
 * click to show a full animation, so it is started here and always runs to the end. A data attribute is
 * used instead of a class so Svelte's class bindings cannot clobber it mid-animation.
 */
export function installPressFeedback(): void {
  document.addEventListener('pointerdown', (event) => {
    if (event.button == 0) {
      const element = pressableFrom(event.target);

      if (element) {
        play(element);
      }
    }
  });

  // Keyboard activation (Enter/Space) fires a click without a preceding pointerdown; `detail` is 0 then.
  document.addEventListener('click', (event) => {
    if (event.detail == 0) {
      const element = pressableFrom(event.target);

      if (element) {
        play(element);
      }
    }
  });

  document.addEventListener('animationend', (event) => {
    if ((event.animationName == 'press') && (event.target instanceof HTMLElement)) {
      event.target.removeAttribute('data-pressed');
    }
  });
}
