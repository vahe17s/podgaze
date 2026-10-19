import { useEffect, useRef, useState, type RefObject } from "react";

// With `gazing`, the pupil looks around and the eye blinks now and then: the app's "looking for something" state.
export function Logo({ size = 28, gazing = false }: { size?: number; gazing?: boolean }) {
  const pupil = useRef<SVGGElement>(null);
  const eye = useRef<SVGGElement>(null);
  useGlances(pupil, eye, gazing, LOADER_PACE);
  return (
    <svg className={gazing ? "logo gazing" : "logo"} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="#2f81f7" />
      <g ref={eye} className="logo-eye">
        <path
          d="M5.5 16.2c2.2-3.8 5.4-5.7 10.5-5.7s8.3 1.9 10.5 5.7c-2.2 3.8-5.4 5.7-10.5 5.7s-8.3-1.9-10.5-5.7z"
          fill="#fff"
        />
        <g ref={pupil} className="logo-pupil">
          <circle cx="16" cy="16.2" r="3.1" fill="#0d1117" />
          <circle cx="17.1" cy="15.2" r="1" fill="#fff" />
        </g>
      </g>
    </svg>
  );
}

const NEAR = 220;
// The pupil glances at one of these spots (in viewBox units) or the eye blinks, now and then.
const GLANCES: readonly (readonly [number, number])[] = [[0, 0], [-4.4, -0.7], [4.4, -0.5], [2.4, 1.5], [-2.6, 1.3]];
const BLINK_MS = 140;
const SETTLE_MS = 45;

function place(pupil: SVGGElement | null, x: number, y: number) {
  if (pupil) pupil.style.transform = x || y ? `translate(${x}px, ${y}px)` : "";
}

type Pace = { first: number; every: number; spread: number };
// A loader is on screen for a moment, so it looks around sooner and more often than the idle sidebar eye.
const LOADER_PACE: Pace = { first: 250, every: 1100, spread: 900 };
const IDLE_PACE: Pace = { first: 2600, every: 2600, spread: 3400 };

// Nobody is looking (window hidden or in the background, see main.tsx) or motion is turned down.
function holdStill() {
  const root = document.documentElement;
  return (
    document.hidden ||
    root.dataset.inactive !== undefined ||
    root.dataset.motion === "reduce" ||
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
}

// Each glance or blink is a couple of jumps with the eye holding still in between, so the window redraws
// a few frames now and then. Without a GPU (WSL, remote desktops, VMs) every frame costs CPU however small
// the change: the endless CSS animation this replaces redrew 60 times a second and made video in other
// apps stutter, and even sliding transitions cost several times more than jumps.
function useGlances(pupil: RefObject<SVGGElement | null>, eye: RefObject<SVGGElement | null>, on: boolean, pace: Pace) {
  useEffect(() => {
    if (!on) return;
    let timer = 0;
    let blink = 0;
    let settle = 0;
    let at = 0;
    const step = () => {
      if (!holdStill()) {
        if (Math.random() < 0.25) {
          eye.current?.classList.add("blink");
          blink = window.setTimeout(() => eye.current?.classList.remove("blink"), BLINK_MS);
        } else {
          // A jump like a real eye: halfway, then there. Two frames, where a sliding transition draws ~20.
          const [fromX, fromY] = GLANCES[at]!;
          at = (at + 1 + Math.floor(Math.random() * (GLANCES.length - 1))) % GLANCES.length;
          const [x, y] = GLANCES[at]!;
          place(pupil.current, (fromX + x) / 2, (fromY + y) / 2);
          settle = window.setTimeout(() => place(pupil.current, x, y), SETTLE_MS);
        }
      }
      timer = window.setTimeout(step, pace.every + Math.random() * pace.spread);
    };
    timer = window.setTimeout(step, pace.first);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(blink);
      window.clearTimeout(settle);
      eye.current?.classList.remove("blink");
    };
  }, [pupil, eye, on, pace]);
}

const REACH_X = 4.4;
const REACH_Y = 2.2;

type Mood = "idle" | "watching" | "closed" | "dizzy";

const moodTitle: Record<Mood, string> = {
  idle: "Podgaze is looking around",
  watching: "Podgaze sees you",
  closed: "Ouch",
  dizzy: "Okay, okay, I'm awake",
};

// The sidebar mascot: gazes around on its own, follows the cursor when it comes close, shuts when poked.
export function WatchingLogo({ size = 40 }: { size?: number }) {
  const root = useRef<HTMLButtonElement>(null);
  const pupil = useRef<SVGGElement>(null);
  const eye = useRef<SVGGElement>(null);
  const [mood, setMood] = useState<Mood>("idle");
  const [hover, setHover] = useState(false);
  const moodRef = useRef<Mood>("idle");
  const pokes = useRef<number[]>([]);
  moodRef.current = mood;

  useEffect(() => {
    let frame = 0;
    let last: { x: number; y: number } | null = null;
    const track = () => {
      frame = 0;
      const button = root.current;
      if (!button || !last) return;
      const current = moodRef.current;
      if (current === "closed" || current === "dizzy") return;
      const box = button.getBoundingClientRect();
      const dx = last.x - (box.left + box.width / 2);
      const dy = last.y - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy);
      if (distance > NEAR) {
        if (current !== "idle") setMood("idle");
        if (pupil.current) pupil.current.style.transform = "";
        return;
      }
      if (current !== "watching") setMood("watching");
      // Leans further the further away the cursor is, up to the edge of the eye.
      const pull = Math.min(1, distance / (box.width * 1.4));
      const x = distance === 0 ? 0 : (dx / distance) * REACH_X * pull;
      const y = distance === 0 ? 0 : (dy / distance) * REACH_Y * pull;
      if (pupil.current) pupil.current.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
    };
    const onMove = (event: MouseEvent) => {
      last = { x: event.clientX, y: event.clientY };
      if (!frame) frame = window.requestAnimationFrame(track);
    };
    const onLeave = () => {
      last = null;
      if (moodRef.current === "watching") setMood("idle");
      if (pupil.current) pupil.current.style.transform = "";
    };
    window.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  // Idle, the eye looks around on its own; the cursor coming close takes over (see above).
  useGlances(pupil, eye, mood === "idle", IDLE_PACE);

  useEffect(() => {
    if (mood !== "dizzy") return;
    if (pupil.current) pupil.current.style.transform = "";
    const timer = window.setTimeout(() => setMood("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [mood]);

  function open() {
    if (moodRef.current === "closed") setMood("watching");
  }

  return (
    <button
      ref={root}
      type="button"
      className="logo-buddy"
      aria-label="Podgaze"
      title={moodTitle[mood]}
      onPointerDown={() => {
        const now = Date.now();
        pokes.current = [...pokes.current.filter((time) => now - time < 2000), now];
        if (pokes.current.length >= 5) {
          pokes.current = [];
          setMood("dizzy");
          return;
        }
        if (moodRef.current !== "dizzy") setMood("closed");
      }}
      onPointerUp={open}
      onPointerLeave={open}
      onPointerEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <svg
        className={["logo", mood, hover && mood === "watching" ? "wide" : ""].filter(Boolean).join(" ")}
        width={size}
        height={size}
        viewBox="0 0 32 32"
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="9" fill="#2f81f7" />
        <g ref={eye} className="logo-eye">
          <path d="M5.5 16.2c2.2-3.8 5.4-5.7 10.5-5.7s8.3 1.9 10.5 5.7c-2.2 3.8-5.4 5.7-10.5 5.7s-8.3-1.9-10.5-5.7z" fill="#fff" />
          <g ref={pupil} className="logo-pupil">
            <g className="logo-iris">
              <circle cx="16" cy="16.2" r="3.1" fill="#0d1117" />
              <circle cx="17.1" cy="15.2" r="1" fill="#fff" />
            </g>
          </g>
        </g>
      </svg>
    </button>
  );
}
