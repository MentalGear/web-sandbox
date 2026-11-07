import { styleMarkup, type StyleMarkup } from '@src/lib/style-markup';

let parses = 0;

/**
 * Parses `html` into an inert template as the view does (inSandboxView, `parserInput`): encoded so that the parse makes no
 * style attribute and no <style> element (style-markup.ts), under a nonce of its own. `markup` is the encoding to give the
 * renderer (RenderContext.markup), or undefined where nothing had to be renamed.
 */
export function parseAsView(html: string): { template: HTMLTemplateElement; markup: StyleMarkup | undefined } {
    const encoding = styleMarkup(`wunittest${(parses++).toString(36)}`);
    const text = encoding.encode(html);
    const template = document.createElement('template');
    template.innerHTML = text;
    return { template, markup: text === html ? undefined : encoding };
}

/** Parses `html` into an inert template as it is, unencoded: what a caller of the renderer that only cleans markup gives it. */
export function parseAsIs(html: string): { template: HTMLTemplateElement; markup: undefined } {
    const template = document.createElement('template');
    template.innerHTML = html;
    return { template, markup: undefined };
}

/** The `style` attribute the engine writes for `css` given to an element's declaration: what the renderer leaves for it. */
export function declared(css: string): string | null {
    const element = document.createElement('p');
    element.style.cssText = css;
    return element.getAttribute('style');
}
