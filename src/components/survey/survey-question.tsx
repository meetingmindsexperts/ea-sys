"use client";

/**
 * One survey question as attendees answer it: the numbered card and the input
 * for each question type. Shared by the public survey page (/e/[slug]/survey)
 * and the end-of-webinar survey popup, so a question looks and behaves the
 * same in both. Answers are strings here (a rating is "1" to "5"); the server
 * validates and types them.
 */

import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SurveyQuestion } from "@/lib/survey/schema";

export function QuestionCard({
  index,
  question,
  value,
  onChange,
  hasError,
  disabled = false,
}: {
  index: number;
  question: SurveyQuestion;
  value: string;
  onChange: (next: string) => void;
  hasError: boolean;
  disabled?: boolean;
}) {
  const answered = value !== "";

  return (
    <div
      className={`group rounded-2xl border bg-card p-5 shadow-sm transition-colors animate-in fade-in slide-in-from-bottom-3 fill-mode-backwards sm:p-6 ${
        hasError ? "border-destructive/60 ring-1 ring-destructive/20" : "border-border hover:border-primary/30"
      }`}
      style={{ animationDelay: `${Math.min(index, 8) * 70}ms`, animationDuration: "500ms" }}
    >
      <div className="flex gap-3.5">
        {/* Number badge — fills with the brand gradient once answered */}
        <div
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-all ${
            answered
              ? "bg-gradient-primary text-white shadow-sm shadow-primary/30"
              : hasError
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
          }`}
          aria-hidden
        >
          {answered ? <Check className="h-3.5 w-3.5" /> : index + 1}
        </div>

        <div className="min-w-0 flex-1">
          <Label
            htmlFor={question.id}
            className={`block text-[0.95rem] font-medium leading-snug ${hasError ? "text-destructive" : ""}`}
          >
            {question.label}
            {question.required ? (
              <span className="ml-1 text-destructive">*</span>
            ) : (
              <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 align-middle text-[0.65rem] font-normal text-muted-foreground">
                Optional
              </span>
            )}
          </Label>

          <div className="mt-3">
            <QuestionInput
              question={question}
              value={value}
              onChange={onChange}
              hasError={hasError}
              disabled={disabled}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function QuestionInput({
  question,
  value,
  onChange,
  hasError,
  disabled,
}: {
  question: SurveyQuestion;
  value: string;
  onChange: (next: string) => void;
  hasError: boolean;
  disabled: boolean;
}) {
  switch (question.type) {
    case "single_select":
      return (
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger
            id={question.id}
            className={`h-11 rounded-xl ${hasError ? "border-destructive" : ""}`}
          >
            <SelectValue placeholder="Choose an option" />
          </SelectTrigger>
          <SelectContent>
            {question.options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "rating_1_to_5":
      return (
        <div>
          <div className="flex gap-2" role="radiogroup" aria-label={question.label}>
            {[1, 2, 3, 4, 5].map((n) => {
              const selected = value === String(n);
              return (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={String(n)}
                  disabled={disabled}
                  onClick={() => onChange(String(n))}
                  className={`flex h-12 flex-1 items-center justify-center rounded-xl text-lg font-semibold transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? "btn-gradient scale-[1.04] shadow-md shadow-primary/25"
                      : hasError
                        ? "border border-destructive/50 text-destructive hover:bg-destructive/5"
                        : "border border-input bg-background text-foreground hover:-translate-y-0.5 hover:border-primary/40 hover:text-primary"
                  }`}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>Least satisfied</span>
            <span>Most satisfied</span>
          </div>
        </div>
      );

    case "text":
      return (question.maxLength ?? 0) > 200 ? (
        <Textarea
          id={question.id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          maxLength={question.maxLength}
          rows={4}
          placeholder="Type your answer…"
          className={`rounded-xl ${hasError ? "border-destructive" : ""}`}
        />
      ) : (
        <Input
          id={question.id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          maxLength={question.maxLength}
          placeholder="Type your answer…"
          className={`h-11 rounded-xl ${hasError ? "border-destructive" : ""}`}
        />
      );
  }
}
