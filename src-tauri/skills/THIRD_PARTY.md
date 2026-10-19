# Skills de terceros

lienzo instala estas skills en el proyecto al conectar un agente, junto a las suyas (`lienzo-*`).

| Skill | Origen | Licencia |
|---|---|---|
| caveman | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman/tree/main/skills/caveman) | Apache-2.0 |

Copiada el 18 oct 2026 de la rama `main`. El texto del `SKILL.md` está sin cambios; lienzo solo añade al final un comentario con el origen y su marca de archivo gestionado.
Texto de la licencia: https://www.apache.org/licenses/LICENSE-2.0

`caveman` menciona `ultracave`, `megacave` y `caveman-compress`, que no se instalan.

## Retiradas
`investigate-first`, `surgical-patch`, `verify-and-stop` y `lean-build` (del mismo repositorio) se probaron en un banco A/B
de 24 ejecuciones con Claude Sonnet: mismo resultado, pero un 17 % más de coste (hasta +39 % al verificar o investigar).
lienzo ya no las instala y quita las copias gestionadas que encuentre.
