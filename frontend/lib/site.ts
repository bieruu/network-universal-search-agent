/**
 * The project's own public repository link.
 *
 * One declaration for two surfaces: the landing nav and the dashboard header
 * both render a GitHub link, and two copies of the same URL is the usual way
 * those two end up pointing at different places. The repo named here is
 * `bieruu/network-universal-search-agent` — the one this working tree is
 * (verified against the live remote: public, MIT).
 */
export const GITHUB_REPO_URL = "https://github.com/bieruu/network-universal-search-agent";

/**
 * The link's accessible name. The icon is decorative on its own, so the name
 * has to live on the anchor — and it must be the same name on both surfaces,
 * because a screen-reader user should not have to work out that two different
 * labels describe the same destination.
 */
export const GITHUB_LINK_LABEL = "GitHub repository";
