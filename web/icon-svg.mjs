import paths from './icon-paths.mjs';

// Only trusted, repository-owned path data enters this builder.
export function iconSvg(name, {knobs = false} = {}) {
  const icon = Object.hasOwn(paths, name) ? paths[name] : paths.tracks;
  if (icon === paths.logo) {
    const body = knobs ? icon.body.replaceAll('<circle ', '<circle class="boot-knob" ') : icon.body;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${icon.viewBox}" aria-hidden="true" fill="none" stroke="none">${body}</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none"><path d="${icon.d}"/></svg>`;
}
