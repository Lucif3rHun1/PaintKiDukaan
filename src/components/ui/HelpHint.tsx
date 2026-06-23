import { HelpCircle, MessageCircle } from "lucide-react";

interface Props {
  videoHref?: string;
  whatsappHref?: string;
}

export function HelpHint({ videoHref, whatsappHref }: Props) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <HelpCircle className="h-3.5 w-3.5" />
      {videoHref && (
        <a
          href={videoHref}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground"
        >
          Watch tutorial
        </a>
      )}
      {whatsappHref && (
        <a
          href={whatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground flex items-center gap-1"
        >
          <MessageCircle className="h-3.5 w-3.5" /> WhatsApp help
        </a>
      )}
    </div>
  );
}
