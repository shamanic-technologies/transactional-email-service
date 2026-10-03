import {
  deriveTextFromHtml,
  findUnrenderableImages,
  findUnrenderableImagesInHtml,
  renderUpdateBody,
} from "./mailing-list-body.js";
import { signWithWhy } from "./why.js";

/**
 * Turning what a caller stated into the two parts a message carries.
 *
 * Lives beside the renderer rather than in a route because three surfaces need
 * exactly this answer and must not drift from each other: the preview (whose
 * entire purpose is showing what a send produces), the synchronous send, and a
 * paced release, which resolves the body once at creation and stores the result
 * because the worker that sends it days later has no request to re-read.
 */
export interface ResolvedBody {
  bodyKind: "markdown" | "html";
  /** The markdown source, or null for a body authored as HTML — there is none. */
  markdown: string | null;
  htmlBody: string;
  textBody: string;
  /** Image URLs no client renders. A send refuses on these; a preview reports them. */
  unrenderableImages: string[];
}

/**
 * Turns whatever the caller stated into the two parts a message carries.
 *
 * Markdown is rendered, exactly as it always was. An authored document is NOT:
 * it is the bytes staff wrote, and re-rendering, re-wrapping or inlining
 * anything into it would break the design it exists to carry. So the html path
 * passes the body through and only decides the text part beside it.
 *
 * The one thing both paths gain is the company's why: every list here is
 * distribute.you's own, so every update is signed "Revenue made easy." with a
 * "Get started" link under it, as one self-styled paragraph placed just before
 * `</body>` (or at the end of a fragment). Nothing of the authored markup is
 * rewritten, and a body that already carries the sentence is left as it is.
 *
 * A message with no text part is not an option: clients that prefer text show
 * an empty message and filters read the missing alternative as a signal. The
 * caller may write one; otherwise one is derived; and a document that yields
 * neither — an all-image layout, say — is refused with the ask, because the
 * only thing worse than a rough text part is none.
 *
 * Shared by the send and the preview so the preview cannot drift from what
 * lands in the inbox, which is the reason the preview route exists at all.
 */
export function resolveBody(input: { body?: string; htmlBody?: string; textBody?: string }): ResolvedBody | { error: string } {
  if (input.htmlBody) {
    const authoredText = input.textBody ?? deriveTextFromHtml(input.htmlBody);
    if (authoredText.trim().length === 0) {
      return {
        error:
          "This HTML carries no text a plain-text part could be derived from, and a message with no text part " +
          "arrives empty in clients that prefer text. Supply `textBody`.",
      };
    }

    const signed = signWithWhy({ htmlBody: input.htmlBody, textBody: authoredText }, { withLink: true });

    return {
      bodyKind: "html",
      markdown: null,
      htmlBody: signed.htmlBody,
      textBody: signed.textBody,
      unrenderableImages: findUnrenderableImagesInHtml(input.htmlBody),
    };
  }

  // The schema guarantees one of the two, so this is the markdown path.
  const markdown = input.body as string;
  const rendered = signWithWhy(renderUpdateBody(markdown), { withLink: true });

  return {
    bodyKind: "markdown",
    markdown,
    htmlBody: rendered.htmlBody,
    textBody: rendered.textBody,
    unrenderableImages: findUnrenderableImages(markdown),
  };
}

