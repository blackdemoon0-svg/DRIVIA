import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  DriviaApiError,
  streamDriviaResponse,
  type DriviaAttachment,
  type DriviaMessage,
} from "./lib/driviaApi";
import { prepareQuoteDocument } from "./lib/quoteDocument";

type View = "ai" | "battle";

const QUICK_PROMPTS = [
  { label: "Comparer deux voitures", prompt: "Compare la BMW M3 et la Mercedes-AMG C 63." },
  { label: "Trouver ma prochaine voiture", prompt: "Aide-moi à trouver la voiture adaptée à mes besoins. Pose-moi une question à la fois." },
  { label: "Comprendre une technologie", prompt: "Explique-moi simplement le fonctionnement d'un turbocompresseur." },
  { label: "Préparer un achat", prompt: "Que dois-je vérifier avant d'acheter une voiture d'occasion ?" },
];

const HOME_ACTIONS = [
  {
    number: "01",
    title: "Analyser mon devis",
    description: "Vérifie mon devis de garage",
    prompt: "Je souhaite faire vérifier un devis de garage. Voici les réparations, les pièces et les tarifs indiqués :",
    icon: "quote",
  },
  {
    number: "02",
    title: "Scanner un voyant ou un bruit",
    description: "Analyse une photo d'un voyant ou un court audio",
    prompt: "J'aimerais comprendre un voyant ou un bruit sur ma voiture. Voici le modèle du véhicule et les détails observés :",
    icon: "alert",
  },
  {
    number: "03",
    title: "Analyser une voiture d'occasion",
    description: "Vérifie une voiture avant achat",
    prompt: "Je souhaite vérifier une voiture d'occasion avant achat. Voici les informations de l'annonce (marque, modèle, année, kilométrage et prix) :",
    icon: "car",
  },
] as const;

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

function HomeActionIcon({ icon }: { icon: (typeof HOME_ACTIONS)[number]["icon"] }) {
  if (icon === "quote") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
        <path d="M7 3.75h7.7L18 7.1v8.15" />
        <path d="M14.5 3.9v3.65h3.2M7 3.75v16.5h5.1" />
        <path d="M9.8 10h5.1M9.8 13h3.2" />
        <path d="m15.1 17.2 3.95-3.95 2.15 2.15-3.95 3.95-2.75.65.6-2.8Z" />
      </svg>
    );
  }

  if (icon === "alert") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
        <path d="m12 3.7 9 15.6H3l9-15.6Z" />
        <path d="M12 9v4.6M12 17.1h.01" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path d="m4.1 14.9 1.6-5.25a2 2 0 0 1 1.9-1.4h8.8a2 2 0 0 1 1.9 1.4l1.6 5.25" />
      <path d="M3.5 14.8h17v4.1a1.5 1.5 0 0 1-1.5 1.5h-14a1.5 1.5 0 0 1-1.5-1.5v-4.1Z" />
      <path d="M6.7 16.9h.01M17.3 16.9h.01M6.5 8.3l1.1-3h8.8l1.1 3" />
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
        {variant === "hero" ? "Posez votre question à DRIVIA" : "Ask DRIVIA anything about cars"}
      </label>
      <textarea
        id={`drivia-prompt-${variant}`}
        ref={textareaRef}
        rows={1}
        maxLength={2000}
        placeholder={variant === "hero" ? "Posez votre question à DRIVIA..." : "Ask DRIVIA anything about cars..."}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        aria-label={variant === "hero" ? "Posez votre question à DRIVIA" : "Ask DRIVIA anything about cars"}
      />
      <div className="composer-controls">
        <span className="composer-hint">
          {variant === "hero" ? (
            <>
              Appuyez sur <kbd>Entrée</kbd> pour envoyer <span className="hint-divider">·</span> Maj + Entrée pour un retour à la ligne
            </>
          ) : (
            "DRIVIA can make mistakes. Verify important details."
          )}
        </span>
        <button
          type="submit"
          className="send-button"
          disabled={!value.trim() || isLoading}
          aria-label={variant === "hero" ? "Envoyer le message" : "Send message"}
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

function formatFileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} Ko`
    : `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function QuoteUploadDialog({
  onClose,
  onAnalyze,
}: {
  onClose: () => void;
  onAnalyze: (file: File, attachments: DriviaAttachment[]) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !isPreparing) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isPreparing, onClose]);

  const selectFile = (candidate: File | undefined) => {
    if (!candidate || isPreparing) return;
    const isPdf = candidate.type === "application/pdf" || candidate.name.toLowerCase().endsWith(".pdf");
    const isImage =
      ["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif"].includes(candidate.type.toLowerCase()) ||
      /\.(jpe?g|png|webp|avif|heic|heif)$/i.test(candidate.name);

    if (candidate.size === 0) {
      setFile(null);
      setFileError("Le fichier sélectionné est vide.");
    } else if (candidate.size > 12 * 1024 * 1024) {
      setFile(null);
      setFileError("Le fichier dépasse la limite de 12 Mo.");
    } else if (!isPdf && !isImage) {
      setFile(null);
      setFileError("Format non pris en charge. Importez une photo JPG, PNG, WebP, HEIC ou AVIF, ou un PDF.");
    } else {
      setFile(candidate);
      setFileError(null);
    }
  };

  const clearFile = () => {
    setFile(null);
    setFileError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleAnalyze = async () => {
    if (!file || isPreparing) return;
    setIsPreparing(true);
    setFileError(null);

    try {
      const attachments = await prepareQuoteDocument(file);
      setIsPreparing(false);
      onAnalyze(file, attachments);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Impossible de préparer ce document.");
      setIsPreparing(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    selectFile(event.dataTransfer.files[0]);
  };

  return (
    <div className="dialog-backdrop" onMouseDown={() => !isPreparing && onClose()}>
      <section
        className="about-dialog quote-upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quote-upload-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          autoFocus
          aria-label="Fermer l'analyse du devis"
          onClick={onClose}
          disabled={isPreparing}
        >
          <span />
          <span />
        </button>

        <p className="eyebrow quote-upload-eyebrow"><span className="eyebrow-dot" /> ANALYSE DE DEVIS</p>
        <h2 id="quote-upload-title">Importez votre devis ou votre facture.</h2>
        <p className="quote-upload-intro">Ajoutez une photo nette ou un PDF lisible pour obtenir une première lecture des lignes et des montants.</p>

        <input
          ref={fileInputRef}
          className="sr-only"
          id="quote-document-file"
          type="file"
          accept=".pdf,application/pdf,image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif"
          onChange={(event) => {
            selectFile(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
          disabled={isPreparing}
        />

        <div
          className={`quote-dropzone${isDragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
              setIsDragging(false);
            }
          }}
          onDrop={handleDrop}
        >
          {file ? (
            <div className="quote-file-summary">
              <span className="quote-file-badge" aria-hidden="true">
                {file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf") ? "PDF" : "IMG"}
              </span>
              <span className="quote-file-meta">
                <strong title={file.name}>{file.name}</strong>
                <small>{formatFileSize(file.size)} · prêt à analyser</small>
              </span>
              <span className="quote-file-actions">
                <label className="quote-replace-file" htmlFor="quote-document-file">Remplacer</label>
                <button className="quote-remove-file" type="button" onClick={clearFile} disabled={isPreparing}>
                  Retirer
                </button>
              </span>
            </div>
          ) : (
            <div className="quote-drop-prompt">
              <span className="quote-upload-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none">
                  <path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5" />
                  <path d="M5 14.5v4.25c0 .69.56 1.25 1.25 1.25h11.5c.69 0 1.25-.56 1.25-1.25V14.5" />
                </svg>
              </span>
              <span className="quote-drop-copy"><strong>Glissez votre document ici</strong><small>ou choisissez un fichier depuis votre appareil</small></span>
              <label className="quote-select-file" htmlFor="quote-document-file">Choisir un fichier</label>
            </div>
          )}
        </div>

        <p className="quote-format-note">JPG, PNG, WebP, HEIC/HEIF, AVIF ou PDF · 12 Mo maximum · PDF jusqu'à 12 pages. Pour un PDF scanné, jusqu'à 4 pages peuvent être transmises.</p>
        {fileError && <p className="quote-upload-error" role="alert">{fileError}</p>}

        <div className="quote-safety-note">
          <span className="quote-safety-mark" aria-hidden="true">i</span>
          <p>Le document est transmis au fournisseur IA configuré. DRIVIA fournit une aide à la lecture, pas un diagnostic professionnel; vérifiez les données personnelles avant l'envoi. Les incertitudes seront signalées.</p>
        </div>

        <button className="quote-analyze-button" type="button" disabled={!file || isPreparing} onClick={handleAnalyze}>
          {isPreparing ? "Préparation du document…" : "Analyser le document"}
          {!isPreparing && <ArrowIcon diagonal />}
        </button>
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
  const [quoteDialogOpen, setQuoteDialogOpen] = useState(false);
  const [quoteRetryAvailable, setQuoteRetryAvailable] = useState(false);
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

  const runConversation = async (
    conversation: DriviaMessage[],
    options: { attachments?: DriviaAttachment[]; task?: "garage-quote" } = {},
  ) => {
    const isQuoteAnalysis = options.task === "garage-quote";
    setQuoteRetryAvailable(false);
    setMessages([...conversation, { role: "assistant", content: "" }]);
    setDraft("");
    setView("ai");
    setChatError(null);
    setIsLoading(true);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      await streamDriviaResponse(
        conversation,
        (delta) => {
          setMessages((current) => {
            const lastMessage = current[current.length - 1];
            if (lastMessage?.role === "assistant") {
              return [...current.slice(0, -1), { ...lastMessage, content: lastMessage.content + delta }];
            }
            return [...current, { role: "assistant", content: delta }];
          });
        },
        options,
      );
    } catch (error) {
      if (isQuoteAnalysis) setQuoteRetryAvailable(true);
      setMessages((current) => {
        const lastMessage = current[current.length - 1];
        return lastMessage?.role === "assistant" && !lastMessage.content
          ? current.slice(0, -1)
          : current;
      });

      if (isQuoteAnalysis) {
        if (error instanceof DriviaApiError && error.status === 429) {
          setChatError("Le service d'analyse est momentanément limité. Réessayez dans un instant.");
        } else if (error instanceof DriviaApiError && error.status === 503) {
          setChatError("L'analyse IA de DRIVIA n'est pas configurée sur le serveur. Le document n'a pas pu être analysé.");
        } else if (error instanceof DriviaApiError && error.status === 404) {
          setChatError("Le service /api/chat est indisponible. Déployez la fonction serveur DRIVIA pour analyser le document.");
        } else if (error instanceof DriviaApiError && error.status === 0) {
          setChatError("Le service d'analyse n'est pas joignable pour le moment. Réessayez plus tard.");
        } else {
          setChatError("DRIVIA n'a pas pu analyser ce document. Vérifiez le fichier ou réessayez plus tard.");
        }
      } else if (error instanceof DriviaApiError && error.status === 429) {
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

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || isLoading) return;

    await runConversation([...messages, { role: "user", content }]);
  };

  const handleQuoteAnalysis = (file: File, attachments: DriviaAttachment[]) => {
    if (isLoading) return;
    setQuoteDialogOpen(false);
    const userMessage: DriviaMessage = {
      role: "user",
      content: `Analyser mon devis de garage : ${file.name}`,
    };
    const previousMessages = quoteRetryAvailable ? [] : messages;
    void runConversation([...previousMessages, userMessage], { attachments, task: "garage-quote" });
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
      ) : quoteDialogOpen ? (
        <QuoteUploadDialog
          onClose={() => setQuoteDialogOpen(false)}
          onAnalyze={handleQuoteAnalysis}
        />
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
            {chatError && (
              <div className="connection-note" role="alert">
                {chatError}
                {quoteRetryAvailable && (
                  <button className="quote-retry-button" type="button" onClick={() => setQuoteDialogOpen(true)}>
                    Réimporter le document <ArrowIcon diagonal />
                  </button>
                )}
              </div>
            )}
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
            <p className="eyebrow hero-eyebrow"><span className="eyebrow-dot" /> VOTRE COMPAGNON AUTOMOBILE AU QUOTIDIEN</p>
            <h1 className="hero-brand">DRIVIA<span>.</span></h1>
            <h2 className="hero-statement">L'automobile, en toute clarté.</h2>
            <p className="hero-description">Un devis de garage, un voyant ou une voiture à vérifier ? Choisissez un point de départ ou échangez directement avec DRIVIA.</p>

            <section className="home-action-section" aria-labelledby="home-action-title">
              <div className="home-action-heading">
                <div>
                  <span className="home-action-kicker">CHOISISSEZ VOTRE BESOIN</span>
                  <h2 className="home-action-title" id="home-action-title">Que souhaitez-vous faire aujourd'hui ?</h2>
                </div>
                <span className="home-action-count">01—03</span>
              </div>

              <div className="home-action-grid">
                {HOME_ACTIONS.map((action) => (
                  <button
                    className="home-action-card"
                    key={action.number}
                    type="button"
                    onClick={() => {
                      if (action.icon === "quote") setQuoteDialogOpen(true);
                      else fillPrompt(action.prompt);
                    }}
                  >
                    <span className="home-action-card-head">
                      <span className="home-action-icon"><HomeActionIcon icon={action.icon} /></span>
                      <span className="home-action-number">{action.number}</span>
                    </span>
                    <span className="home-action-card-title">{action.title}</span>
                    <span className="home-action-card-description">{action.description}</span>
                    <ArrowIcon diagonal />
                  </button>
                ))}
              </div>
            </section>

            <div className="home-chat-choice">
              <div className="home-chat-copy">
                <span className="home-chat-title">Une question plus générale ?</span>
                <span className="home-chat-description">Discutez librement avec DRIVIA.</span>
              </div>
              <button className="home-chat-button" type="button" onClick={openChat}>
                Parler à DRIVIA <ArrowIcon diagonal />
              </button>
            </div>

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
              <span className="quick-prompts-label">QUELQUES IDÉES POUR COMMENCER</span>
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
