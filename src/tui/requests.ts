import { basename } from "node:path";
import type { HostClient } from "../client/client.ts";
import { errorMessage } from "../core/errors.ts";
import type { HarnessRequest, NoticeLevel, RequestResponse } from "../core/events.ts";
import type { ThreadState } from "../protocol.ts";
import type { Key } from "./input.ts";
import {
  ChoicePrompt,
  QuestionPrompt,
  type ChoiceConfig,
  type ChoiceResult,
  type QuestionsResult,
} from "./prompt.ts";
import { commandRisk } from "./risk.ts";

// What the harnesses ask the user, from every thread: approvals and
// questions, kept oldest first, the thread on screen's shown as a prompt in
// the composer's place, and the answers sent back.

/** How long a new prompt ignores keys, which were likely typed for what it covered. */
const PROMPT_GRACE_MS = 400;

/** A request open in a thread; request IDs are only unique per thread. */
export interface OpenRequest {
  threadId: string;
  request: HarnessRequest;
}

function sameRequest(a: OpenRequest, threadId: string, requestId: string): boolean {
  return a.threadId === threadId && a.request.id === requestId;
}

/** What the requests need from the terminal around them. */
export interface RequestHost {
  client: HostClient;
  /** The thread on screen, whose requests are shown. */
  currentId(): string | null;
  /** When the terminal last took a key. */
  typedAt(): number;
  /** A prompt came up, which the view on screen scrolls down to. */
  prompted(): void;
  notice(level: NoticeLevel, text: string): void;
  schedule(): void;
}

export class Requests {
  #host: RequestHost;
  /** Open requests from every thread, oldest first; background ones say whose they are. */
  #open: OpenRequest[] = [];
  /** The prompt on screen, and the request it answers. */
  #prompt: { prompt: ChoicePrompt | QuestionPrompt; asking: OpenRequest } | null = null;
  /** Whether typing was going on when the prompt on screen appeared, and goes on still. */
  #strayTyping = false;

  constructor(host: RequestHost) {
    this.#host = host;
  }

  /** The prompt on screen, if any. */
  get prompt(): ChoicePrompt | QuestionPrompt | null {
    return this.#prompt?.prompt ?? null;
  }

  /** Other threads' open requests, oldest first, which wait for the user to go to them. */
  elsewhere(): OpenRequest[] {
    const here = this.#host.currentId();
    return this.#open.filter((open) => open.threadId !== here);
  }

  /** Keeps the list of open requests in step with a thread's. */
  sync(thread: ThreadState): void {
    const open = new Set(thread.requests.map((request) => request.id));
    this.#open = this.#open.filter(
      (request) => request.threadId !== thread.id || open.has(request.request.id),
    );
    for (const request of thread.requests)
      if (!this.#open.some((other) => sameRequest(other, thread.id, request.id)))
        this.#open.push({ threadId: thread.id, request });
    const asking = this.#prompt?.asking;
    if (asking && asking.threadId === thread.id && !open.has(asking.request.id))
      this.#prompt = null;
    this.next();
  }

  /** Forgets a thread's requests, closing its prompt if one is open. */
  drop(threadId: string): void {
    this.#open = this.#open.filter((open) => open.threadId !== threadId);
    if (this.#prompt?.asking.threadId === threadId) {
      this.#prompt = null;
      this.next();
    }
  }

  /** Forgets every request, as on quitting or when the host catches the terminal up. */
  clear(): void {
    this.#open = [];
    this.#prompt = null;
  }

  /** A thread came on screen: a prompt belongs to the thread it asks for, and comes back with it. */
  shown(threadId: string): void {
    if (this.#prompt && this.#prompt.asking.threadId !== threadId) this.#prompt = null;
    this.next();
  }

  /** A key for the prompt on screen; `sinceLast` is how long since the key before it. */
  key(key: Key, sinceLast: number): void {
    if (!this.#prompt) return;
    // Typing that was going on when a prompt appeared was meant for something else:
    // its keys are dropped until it pauses. Keys after a pause, or after an answer
    // for the next question, are the prompt's.
    if (this.#strayTyping && sinceLast < PROMPT_GRACE_MS) return;
    this.#strayTyping = false;
    this.#prompt.prompt.key(key);
  }

  /**
   * Shows the current thread's oldest request. Other threads' requests wait
   * for the user to open them, announced by the attention line, so a prompt
   * never takes over the composer for a thread not on screen.
   */
  next(): void {
    if (this.#prompt) return;
    const here = this.#host.currentId();
    const next = this.#open.find((open) => open.threadId === here);
    if (!next) return;
    const request = next.request;
    const respond = (response: RequestResponse) => this.#respond(next, response);
    if (request.kind === "approval") {
      const { action } = request;
      const risk = action.type === "command" ? commandRisk(action.command) : null;
      // What can lose work deserves a fresh look each time, so it can't be allowed for good.
      const options = risk
        ? request.options.filter((option) => option.effect !== "allow-always")
        : request.options;
      // Nor should it be one enter away from going ahead.
      const refusal = risk ? options.findIndex((option) => option.effect === "deny") : -1;
      const initial =
        refusal >= 0
          ? refusal
          : Math.max(
              0,
              options.findIndex((option) => option.id === request.defaultOptionId),
            );
      const command = /^\$ /m.test(request.detail);
      const config: ChoiceConfig = {
        header: "Permission needed",
        tag: command ? "Command" : "",
        title: request.title,
        ...(risk ? { warning: risk } : {}),
        // Where it would land matters as much as what it does.
        ...(risk && action.type === "command" && action.cwd
          ? { where: `in ${basename(action.cwd)}` }
          : {}),
        detail: request.detail ? [request.detail] : [],
        options: options.map((option) => ({
          label: option.label,
          // Refusing bare stops most harnesses' turns; with a reason the agent goes on.
          description: "",
          ...(option.effect === "deny"
            ? { unselected: "tab gives a reason; the agent goes on" }
            : {}),
        })),
        multiSelect: false,
        allowOther: false,
        secret: false,
        initial,
        // A refusal can say why, which the agent hears and goes on with.
        commentable: (index) => options[index]?.effect === "deny",
        comment: "reason",
        escape: "refuse",
      };
      this.#show(
        next,
        (done: (result: ChoiceResult) => void) => new ChoicePrompt(config, done),
        (result) => {
          const option = result.kind === "options" ? options[result.indexes[0] ?? 0] : undefined;
          const reason = result.kind === "options" ? result.comment?.text : undefined;
          respond(
            !option
              ? { kind: "cancel" }
              : option.effect === "deny" && reason
                ? { kind: "decline", reason }
                : { kind: "approval", optionId: option.id },
          );
        },
      );
      return;
    }
    // All of a request's questions in one prompt, to move between and annotate.
    const configs: ChoiceConfig[] = request.questions.map((question) => ({
      header: "Question",
      tag: question.header,
      title: question.question,
      detail: [],
      options: question.options,
      multiSelect: question.multiSelect,
      allowOther: question.allowOther,
      // The agent is told the question went unanswered, and carries on.
      escape: "skip, the agent carries on",
      secret: question.secret,
      initial: 0,
      commentable: () => true,
      comment: "note",
    }));
    this.#show(
      next,
      (done: (result: QuestionsResult) => void) => new QuestionPrompt(configs, done),
      (result) => {
        if (result.kind === "cancel") {
          respond({ kind: "cancel" });
          return;
        }
        const answers: Record<string, string[]> = {};
        request.questions.forEach((question, index) => {
          const answer = result.answers[index];
          if (!answer) return;
          // A comment goes beside the answer, as one more of its values, saying
          // which option it is on where there could be more than one.
          const { comment } = answer;
          const on = question.options[comment?.index ?? -1]?.label;
          answers[question.id] = [
            ...answer.indexes.map((choice) => question.options[choice]?.label ?? ""),
            ...(answer.text !== null ? [answer.text] : []),
            ...(comment
              ? [
                  question.multiSelect && on
                    ? `comment on ${on}: ${comment.text}`
                    : `comment: ${comment.text}`,
                ]
              : []),
          ];
        });
        respond({ kind: "question", answers });
      },
    );
  }

  /** Shows the prompt `make` builds, which calls `onDone` with its answer. */
  #show<R>(
    asking: OpenRequest,
    make: (done: (result: R) => void) => ChoicePrompt | QuestionPrompt,
    onDone: (result: R) => void,
  ): void {
    const prompt = make((result) => {
      if (this.#prompt?.prompt === prompt) this.#prompt = null;
      onDone(result);
      // The prompt that follows an answer, such as the next request's, takes keys at once.
      this.#strayTyping = false;
      this.#host.schedule();
    });
    this.#prompt = { prompt, asking };
    this.#strayTyping = Date.now() - this.#host.typedAt() < PROMPT_GRACE_MS;
    this.#host.prompted();
    this.#host.schedule();
  }

  #respond(asked: OpenRequest, response: RequestResponse): void {
    const { threadId, request } = asked;
    this.#open = this.#open.filter((open) => !sameRequest(open, threadId, request.id));
    this.#host.client
      .call("thread.respond", { threadId, requestId: request.id, response })
      .catch((error: unknown) => this.#host.notice("error", errorMessage(error)));
    this.next();
  }
}
