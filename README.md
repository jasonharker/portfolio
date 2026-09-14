# portfolio

Source for https://jasonharker.com — a static Astro site served by unprivileged nginx.

    npm install
    npm run dev

## Delivery

1. Push to `main` → Jenkins builds with Kaniko, Trivy gates on CRITICAL, pushes `portfolio:<sha8>` to the zeno registry.
2. Jenkins commits the tag to `apps/portfolio-staging/deployment.yaml` in `thales-kubernetes`; Flux applies it.
3. Flagger runs a blue/green analysis in `portfolio-staging` and promotes or rolls back.
4. Promote to production with a PR copying the passed tag into `apps/portfolio/deployment.yaml`.

The previous site is archived at https://testing.jasonharker.com (`jasonharker/testing-dashboard`).
