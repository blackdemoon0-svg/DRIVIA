import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { DriviaApiError, streamDriviaResponse, type DriviaMessage } from "./lib/driviaApi";

type View = "ai" | "battle";

const QUICK_PROMPTS = [
  { label: "Compare two cars", prompt: "Compare the BMW M3 and Mercedes-AMG C 63." },
  { label: "Find my next car", prompt: "Help me find the right car for my needs. Ask me one question at a time." },
  { label: "Explain a technology", prompt: "Explain how a turbocharger works, in simple terms." },
  { label: "Help me buy a car", prompt: "What should I check before buying a used car?" },
];

type Vehicle = {
  id: string;
  name: string;
  price: string;
  priceNumber: number;
  power: string;
  powerNumber: number;
  torque: string;
  torqueNumber: number;
  acceleration: string;
  accelerationNumber: number;
  topSpeed: string;
  topSpeedNumber: number;
  weight: string;
  weightNumber: number;
  engine: string;
  fuel: string;
  drivetrain: string;
};

const VEHICLES: Vehicle[] = [
  {
    id: "m3",
    name: "BMW M3 Competition xDrive",
    price: "~€108,000",
    priceNumber: 108,
    power: "530 hp",
    powerNumber: 530,
    torque: "650 Nm",
    torqueNumber: 650,
    acceleration: "3.5 sec",
    accelerationNumber: 3.5,
    topSpeed: "250 km/h",
    topSpeedNumber: 250,
    weight: "1,855 kg",
    weightNumber: 1855,
    engine: "3.0L twin-turbo inline-6",
    fuel: "Petrol",
    drivetrain: "AWD",
  },
  {
    id: "rs5",
    name: "Audi RS 5 Sportback",
    price: "~€105,000",
    priceNumber: 105,
    power: "450 hp",
    powerNumber: 450,
    torque: "600 Nm",
    torqueNumber: 600,
    acceleration: "3.9 sec",
    accelerationNumber: 3.9,
    topSpeed: "250 km/h",
    topSpeedNumber: 250,
    weight: "1,785 kg",
    weightNumber: 1785,
    engine: "2.9L twin-turbo V6",
    fuel: "Petrol",
    drivetrain: "AWD",
  },
  {
    id: "c63",
    name: "Mercedes-AMG C 63 S E Performance",
    price: "~€123,000",
    priceNumber: 123,
    power: "680 hp",
    powerNumber: 680,
    torque: "1,020 Nm",
    torqueNumber: 1020,
    acceleration: "3.4 sec",
    accelerationNumber: 3.4,
    topSpeed: "280 km/h",
    topSpeedNumber: 280,
    weight: "2,180 kg",
    weightNumber: 2180,
    engine: "2.0L turbo-4 + electric motor",
    fuel: "Plug-in hybrid",
    drivetrain: "AWD",
  },
  {
    id: "model-3",
    name: "Tesla Model 3 Performance",
    price: "~€60,000",
    priceNumber: 60,
    power: "510 hp*",
    powerNumber: 510,
    torque: "741 Nm*",
    torqueNumber: 741,
    acceleration: "3.1 sec",
    accelerationNumber: 3.1,
    topSpeed: "262 km/h",
    topSpeedNumber: 262,
    weight: "1,851 kg",
    weightNumber: 1851,
    engine: "Dual electric motors",
    fuel: "Electric",
    drivetrain: "AWD",
  },
];

type ComposerProps = {
  variant: "hero" | "chat";
  value: string;
  isLoading: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={small ? "brand-mark brand-mark-small" : "brand-mark"}
      viewBox="0 0 32 32"
      fill="none"
    >
      <path d="M8 5.5h8a10.5 10.5 0 1 1-9.1 5.3" />
      <path d="M6 4.5v7h7" />
      <path className="brand-mark-accent" d="M13 11.5h3.2a4.5 4.5 0 0 1 0 9H13" />
    </svg>
  );
}

function ArrowIcon({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      className={diagonal ? "arrow-icon arrow-icon-diagonal" : "arrow-icon"}
    >
      {diagonal ? (
        <path d="M5.5 14.5 14 6m0 0H7m7 0v7" />
      ) : (
        <path d="M10 15V5m0 0L6 9m4-4 4 4" />
      )}
    </svg>
  );
}

function Composer({
  variant,
  value,
  isLoading,
  textareaRef,
  onChange,
  onKeyDown,
  onSubmit,
}: ComposerProps) {
  return (
    <form className={`composer composer-${variant}`} onSubmit={onSubmit}>
      <label className="sr-only" htmlFor={`drivia-prompt-${variant}`}>
        Ask DRIVIA anything about cars
      </label>
      <textarea
        id={`drivia-prompt-${variant}`}
        ref={textareaRef}
        rows={1}
        maxLength={2000}
        placeholder="Ask DRIVIA anything about cars..."
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        aria-label="Ask DRIVIA anything about cars"
      />
      <div className="composer-controls">
        <span className="composer-hint">
          {variant === "hero" ? (
            <>
              Press <kbd>Enter</kbd> to send <span className="hint-divider">·</span> Shift + Enter for a new line
            </>
          ) : (
            "DRIVIA can make mistakes. Verify important details."
          )}
        </span>
        <button
          type="submit"
          className="send-button"
          disabled={!value.trim() || isLoading}
          aria-label="Send message"
        >
          <ArrowIcon />
        </button>
      </div>
    </form>
  );
}

function LoadingMessage() {
  return (
    <div className="assistant-turn loading-turn" role="status" aria-label="DRIVIA is thinking">
      <div className="assistant-avatar">
        <BrandMark small />
      </div>
      <div className="assistant-message-content">
        <div className="assistant-name">DRIVIA</div>
        <div className="thinking-label">is thinking...</div>
        <div className="typing-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ message, isStreaming = false }: { message: DriviaMessage; isStreaming?: boolean }) {
  if (message.role === "user") {
    return (
      <article className="user-turn">
        <p>{message.content}</p>
      </article>
    );
  }

  return (
    <article className="assistant-turn">
      <div className="assistant-avatar">
        <BrandMark small />
      </div>
      <div className="assistant-message-content">
        <div className="assistant-name">DRIVIA</div>
        <AssistantText content={message.content} />
        {isStreaming && <span className="stream-cursor" aria-hidden="true" />}
      </div>
    </article>
  );
}

function AssistantText({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);

  return (
    <p className="assistant-copy">
      {lines.map((line, lineIndex) => {
        const heading = /^#{1,3}\s+(.+)$/.exec(line);
        const listItem = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
        const body = heading?.[1] ?? listItem?.[1] ?? line;

        return (
          <span className={heading ? "assistant-section-heading" : "assistant-text-line"} key={lineIndex}>
            {listItem && <span className="assistant-bullet" aria-hidden="true">·</span>}
            {body.split(/(\*\*.+?\*\*)/g).map((segment, segmentIndex) => {
              const bold = /^\*\*(.+)\*\*$/.exec(segment);
              return bold ? <strong key={segmentIndex}>{bold[1]}</strong> : segment;
            })}
            {lineIndex < lines.length - 1 && <br />}
          </span>
        );
      })}
    </p>
  );
}

function BattleMode() {
  const [leftId, setLeftId] = useState("m3");
  const [rightId, setRightId] = useState("rs5");
  const [hasBattle, setHasBattle] = useState(false);
  const resultsRef = useRef<HTMLElement>(null);
  const leftCar = VEHICLES.find((vehicle) => vehicle.id === leftId) ?? VEHICLES[0];
  const rightCar = VEHICLES.find((vehicle) => vehicle.id === rightId) ?? VEHICLES[1];

  const metrics = [
    { label: "Price", left: leftCar.price, right: rightCar.price, leftValue: leftCar.priceNumber, rightValue: rightCar.priceNumber },
    { label: "Power", left: leftCar.power, right: rightCar.power, leftValue: leftCar.powerNumber, rightValue: rightCar.powerNumber },
    { label: "Torque", left: leftCar.torque, right: rightCar.torque, leftValue: leftCar.torqueNumber, rightValue: rightCar.torqueNumber },
    {
      label: "0–100 km/h",
      left: leftCar.acceleration,
      right: rightCar.acceleration,
      leftValue: leftCar.accelerationNumber,
      rightValue: rightCar.accelerationNumber,
    },
    { label: "Top speed", left: leftCar.topSpeed, right: rightCar.topSpeed, leftValue: leftCar.topSpeedNumber, rightValue: rightCar.topSpeedNumber },
    { label: "Weight", left: leftCar.weight, right: rightCar.weight, leftValue: leftCar.weightNumber, rightValue: rightCar.weightNumber },
  ];

  const runBattle = () => {
    setHasBattle(true);
    window.setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  const updateLeftCar = (id: string) => {
    setLeftId(id);
    setHasBattle(false);
  };

  const updateRightCar = (id: string) => {
    setRightId(id);
    setHasBattle(false);
  };

  return (
    <main className="battle-stage" id="battle">
      <div className="battle-intro">
        <p className="eyebrow"><span className="eyebrow-dot" /> THE COMPARISON, CLEARED UP</p>
        <h1>DRIVIA <span>Battle</span></h1>
        <p className="battle-subtitle">Two cars. Every detail that matters.</p>
      </div>

      <div className="battle-picker" aria-label="Choose cars to compare">
        <div className="vehicle-select">
          <label htmlFor="battle-car-one"><span>01</span> CAR ONE</label>
          <div className="select-control">
            <select
              id="battle-car-one"
              value={leftId}
              onChange={(event) => updateLeftCar(event.target.value)}
            >
              {VEHICLES.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id} disabled={vehicle.id === rightId}>
                  {vehicle.name}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
          <p>2024 reference specification</p>
        </div>

        <div className="versus-mark" aria-hidden="true"><span />VS<span /></div>

        <div className="vehicle-select">
          <label htmlFor="battle-car-two"><span>02</span> CAR TWO</label>
          <div className="select-control">
            <select
              id="battle-car-two"
              value={rightId}
              onChange={(event) => updateRightCar(event.target.value)}
            >
              {VEHICLES.map((vehicle) => (
                <option key={vehicle.id} value={vehicle.id} disabled={vehicle.id === leftId}>
                  {vehicle.name}
                </option>
              ))}
            </select>
            <ChevronIcon />
          </div>
          <p>2024 reference specification</p>
        </div>
      </div>

      <div className="battle-action-row">
        <button className="battle-button" type="button" onClick={runBattle}>
          {hasBattle ? "Update battle" : "Start battle"}
          <ArrowIcon diagonal />
        </button>
      </div>

      {hasBattle && (
        <section className="battle-results" ref={resultsRef} aria-live="polite" aria-label="Car comparison results">
          <div className="results-intro">
            <p className="eyebrow">SIDE BY SIDE</p>
            <h2><span>{leftCar.name}</span><i>vs</i><span>{rightCar.name}</span></h2>
          </div>

          <div className="comparison-head" aria-hidden="true">
            <span>{leftCar.name}</span>
            <span>SPECIFICATION</span>
            <span>{rightCar.name}</span>
          </div>

          <div className="comparison-list">
            {metrics.map((metric) => {
              const highestValue = Math.max(metric.leftValue, metric.rightValue, 1);
              const leftWidth = Math.max(7, (metric.leftValue / highestValue) * 100);
              const rightWidth = Math.max(7, (metric.rightValue / highestValue) * 100);

              return (
                <div className="comparison-metric" key={metric.label}>
                  <div className="comparison-values">
                    <span className="comparison-value value-left">{metric.left}</span>
                    <span className="comparison-label">{metric.label}</span>
                    <span className="comparison-value value-right">{metric.right}</span>
                  </div>
                  <div className="comparison-bars" aria-hidden="true">
                    <div className="comparison-bar bar-left"><span style={{ width: `${leftWidth}%` }} /></div>
                    <span className="bar-center" />
                    <div className="comparison-bar bar-right"><span style={{ width: `${rightWidth}%` }} /></div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="comparison-details">
            <DetailRow label="Engine" left={leftCar.engine} right={rightCar.engine} />
            <DetailRow label="Fuel type" left={leftCar.fuel} right={rightCar.fuel} />
            <DetailRow label="Drivetrain" left={leftCar.drivetrain} right={rightCar.drivetrain} />
          </div>
          <p className="specification-note">
            Indicative 2024 European-market specifications. Prices and equipment vary by market, trim and model year. Figures marked * are estimates.
          </p>
        </section>
      )}
    </main>
  );
}

function DetailRow({ label, left, right }: { label: string; left: string; right: string }) {
  return (
    <div className="detail-row">
      <span className="detail-value detail-left">{left}</span>
      <span className="detail-label">{label}</span>
      <span className="detail-value detail-right">{right}</span>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="chevron-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="dialog-close" type="button" aria-label="Close about dialog" onClick={onClose}>
          <span />
          <span />
        </button>
        <BrandMark />
        <p className="eyebrow">BUILT FOR THE WAY YOU DRIVE</p>
        <h2 id="about-title">Cars, made clearer.</h2>
        <p className="about-copy">
          DRIVIA is an AI automotive companion for curious drivers. Ask a question in your own words and get a clear, useful answer, without the noise.
        </p>
        <div className="about-divider" />
        <p className="about-footnote">
          Specifications and advice are a starting point, not a substitute for manufacturer information or a qualified mechanic.
        </p>
      </section>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("ai");
  const [messages, setMessages] = useState<DriviaMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const isChatting = view === "ai" && messages.length > 0;

  useEffect(() => {
    if (!aboutOpen) return undefined;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAboutOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [aboutOpen]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: isLoading ? "auto" : "smooth", block: "end" });
  }, [messages, isLoading, chatError]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.currentTarget.value);
    event.currentTarget.style.height = "auto";
    event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 144)}px`;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || isLoading) return;

    const userMessage: DriviaMessage = { role: "user", content };
    const conversation = [...messages, userMessage];
    setMessages([...conversation, { role: "assistant", content: "" }]);
    setDraft("");
    setView("ai");
    setChatError(null);
    setIsLoading(true);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      await streamDriviaResponse(conversation, (delta) => {
        setMessages((current) => {
          const lastMessage = current[current.length - 1];
          if (lastMessage?.role === "assistant") {
            return [...current.slice(0, -1), { ...lastMessage, content: lastMessage.content + delta }];
          }
          return [...current, { role: "assistant", content: delta }];
        });
      });
    } catch (error) {
      setMessages((current) => {
        const lastMessage = current[current.length - 1];
        return lastMessage?.role === "assistant" && !lastMessage.content
          ? current.slice(0, -1)
          : current;
      });

      if (error instanceof DriviaApiError && error.status === 429) {
        setChatError("DRIVIA is at the AI provider's request limit. Wait a moment and try again.");
      } else if (error instanceof DriviaApiError && error.status === 503) {
        setChatError("DRIVIA AI is not configured. Set DRIVIA_AI_API_KEY as a server environment variable and deploy api/chat.ts to connect a real model.");
      } else if (error instanceof DriviaApiError && error.status === 404) {
        setChatError("DRIVIA's /api/chat function is unavailable. Deploy the repository root to Vercel with vercel.json and set DRIVIA_AI_API_KEY in the server environment. Static-only previews cannot run the AI endpoint.");
      } else if (error instanceof DriviaApiError && error.status === 0) {
        setChatError("DRIVIA AI is temporarily unavailable. Make sure the /api/chat server is running and try again.");
      } else {
        setChatError("DRIVIA AI is temporarily unavailable. Check the server-side provider, model and API key settings, then try again.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const fillPrompt = (prompt: string) => {
    setDraft(prompt);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
    });
  };

  const openChat = () => {
    setView("ai");
    window.setTimeout(() => textareaRef.current?.focus(), 80);
  };

  const showAI = () => setView("ai");

  return (
    <div className={`site-shell${isChatting ? " is-chatting" : ""}`}>
      <header className="site-header">
        <button className="brand-button" type="button" aria-label="DRIVIA home" onClick={showAI}>
          <BrandMark />
          <span>DRIVIA</span>
        </button>

        <nav className="main-nav" aria-label="Main navigation">
          <button
            type="button"
            className={view === "ai" ? "nav-link active" : "nav-link"}
            aria-current={view === "ai" ? "page" : undefined}
            onClick={openChat}
          >
            AI
          </button>
          <button
            type="button"
            className={view === "battle" ? "nav-link active" : "nav-link"}
            aria-current={view === "battle" ? "page" : undefined}
            onClick={() => setView("battle")}
          >
            Battle
          </button>
          <button type="button" className="nav-link" onClick={() => setAboutOpen(true)}>
            About
          </button>
        </nav>

        <button className="header-cta" type="button" onClick={openChat}>
          Start chatting <ArrowIcon diagonal />
        </button>
      </header>

      {view === "battle" ? (
        <BattleMode />
      ) : isChatting ? (
        <main className="chat-stage" aria-label="DRIVIA conversation">
          <div className="conversation-scroll">
            {messages.map((message, index) => {
              if (message.role === "assistant" && !message.content) return null;
              return (
                <ChatMessage
                  key={`${message.role}-${index}`}
                  message={message}
                  isStreaming={isLoading && index === messages.length - 1}
                />
              );
            })}
            {isLoading && messages[messages.length - 1]?.content === "" && <LoadingMessage />}
            {chatError && <div className="connection-note" role="alert">{chatError}</div>}
            <div ref={conversationEndRef} />
          </div>
          <div className="chat-composer-wrap">
            <Composer
              variant="chat"
              value={draft}
              isLoading={isLoading}
              textareaRef={textareaRef}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onSubmit={handleSubmit}
            />
          </div>
        </main>
      ) : (
        <main className="hero-stage" id="ai">
          <div className="hero-content">
            <p className="eyebrow hero-eyebrow"><span className="eyebrow-dot" /> AUTOMOTIVE INTELLIGENCE, IN YOUR CORNER</p>
            <h1 className="hero-brand">DRIVIA<span>.</span></h1>
            <h2 className="hero-statement">Your AI automotive companion.</h2>
            <p className="hero-description">Ask questions. Explore cars. Understand automotive technology.</p>

            <Composer
              variant="hero"
              value={draft}
              isLoading={isLoading}
              textareaRef={textareaRef}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onSubmit={handleSubmit}
            />

            <div className="quick-prompts">
              <span className="quick-prompts-label">A GOOD PLACE TO START</span>
              <div className="quick-prompts-list">
                {QUICK_PROMPTS.map((item) => (
                  <button key={item.label} type="button" onClick={() => fillPrompt(item.prompt)}>
                    {item.label}<ArrowIcon diagonal />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </main>
      )}

      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  );
}
