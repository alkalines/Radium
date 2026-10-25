import { useEffect, useRef, useState } from "react";
import { MicIcon } from "lucide-react";

import { InputGroupButton } from "@/components/ui/input-group";

/** The subset of the Web Speech API recognizer this button drives. */
type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: SpeechRecognitionResultList }) => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
};

/** Browsers expose the recognizer under a standard or a WebKit-prefixed global, or not at all. */
type SpeechRecognitionGlobals = {
  SpeechRecognition?: new () => BrowserSpeechRecognition;
  webkitSpeechRecognition?: new () => BrowserSpeechRecognition;
};

/**
 * Composer dictation through the browser's Web Speech API. Each finalized phrase is passed to
 * `onTranscript`; interim results are ignored. Disabled where the browser has no recognizer.
 * Recognition may be performed by a browser vendor service, outside Radium.
 */
export function VoiceInputButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const onTranscriptRef = useRef(onTranscript);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(false);

  onTranscriptRef.current = onTranscript;

  // The recognizer exists only in the browser, so it is created after mount.
  useEffect(() => {
    // The DOM typings do not declare these vendor globals.
    const speechWindow = window as unknown as SpeechRecognitionGlobals;
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognition.onresult = (event) => {
      let finalTranscript = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal) {
          finalTranscript += result[0]?.transcript ?? "";
        }
      }
      if (finalTranscript) onTranscriptRef.current(finalTranscript);
    };

    recognitionRef.current = recognition;
    setIsSupported(true);

    return () => recognition.stop();
  }, []);

  function toggleListening() {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (isListening) {
      recognition.stop();
    } else {
      recognition.start();
    }
  }

  return (
    <InputGroupButton
      size="icon-sm"
      aria-label={isListening ? "Stop voice input" : "Voice input"}
      aria-pressed={isListening}
      disabled={!isSupported}
      className={isListening ? "bg-accent text-accent-foreground" : undefined}
      onClick={toggleListening}
    >
      <MicIcon />
    </InputGroupButton>
  );
}
