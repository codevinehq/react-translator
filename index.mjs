import fs from "fs-extra";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import types from "@babel/types";
import _ from "lodash";
import path from "path";
import isPropValid from "@emotion/is-prop-valid";
import FastGlob from "fast-glob";
import chalk from "chalk";

const shuffle = (str) => [...str].sort(() => Math.random() - 0.5).join("");

function startsWithCapital(word = "a") {
  return word.charAt(0) === word.charAt(0).toUpperCase();
}

function mockTranslateDeep(obj, prefix) {
  return _.transform(obj, function (result, value, key) {
    // transform to a new object

    result[key] = _.isObject(value)
      ? mockTranslateDeep(value, prefix)
      : `${prefix} ${shuffle(value)}`;
  });
}

const isMultiWord = (str) =>
  str.trim() !== "" && str.includes(" ") && /[a-z]+(?:\s[a-z]+)+/i.test(str);

(async function () {
  const componentBase = "/Users/iv0697/Code/DealerPlatform/src/components/";
  const globBase = componentBase + "*";
  const translationBase =
    "/Users/iv0697/Code/DealerPlatform/public/static/locales";
  const altLocales = ["de"];

  const only = [
    // Add top level component directories here to only process that folder e.g.
    // "/Customer",
  ];

  const dirs = (await FastGlob(globBase, { onlyDirectories: true })).filter(
    (dir) => !only.length || only.some((o) => dir.endsWith(o))
  );
  // const dirs = ["test"];

  let hookErrors = [];

  for (let dirIndex = 0; dirIndex < dirs.length; dirIndex++) {
    const dirPath = dirs[dirIndex];
    const namespace = path.basename(dirPath);
    // const files = ["/Users/iv0697/Code/translator/Test.jsx"];
    const files = await FastGlob(dirPath + "/**/*.js");
    let translations = {};

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const filePath = files[fileIndex];
      const code = await fs.readFile(filePath, "utf-8");

      try {
        const ast = parser.parse(code, {
          sourceType: "module",
          plugins: ["jsx", ["decorators", { decoratorsBeforeExport: false }]],
        });
        let hasTranslations = false;
        let isClassComp = false;
        let HocOrHookAdded = false;
        let name = "";
        // let needsObeserverUpdate =
        //   code.includes("observer") && !code.includes("class ");
        // let needsObserverForHookImport = false;

        const isReact = ast.program.body.some((n) => {
          return n.source?.value === "react";
        });

        if (!isReact) {
          continue;
        }

        traverse.default(ast, {
          enter(nodePath) {
            // Skip translated files
            if (
              nodePath.isImportDeclaration() &&
              nodePath.node.source.value === "react-i18next"
            ) {
              throw new Error("Already translated");
            }

            // Get name of component (used as key)
            const classList = ["PureComponent", "React", "Component"];
            if (
              nodePath.isClassDeclaration() &&
              (classList.includes(nodePath.node.superClass?.object?.name) ||
                classList.includes(nodePath.node.superClass?.name))
            ) {
              isClassComp = true;
              name = nodePath.node.id.name;
            }
            if (!name && nodePath.isExportDefaultDeclaration()) {
              name = nodePath.node.declaration.name;
            }
            if (
              !name &&
              nodePath.isArrowFunctionExpression() &&
              nodePath.parentPath?.parentPath?.parentPath?.node.type ===
                "Program" &&
              startsWithCapital(nodePath.parent?.id?.name)
            ) {
              name = nodePath.parent?.id?.name;
            }
            if (
              !name &&
              nodePath.isFunctionDeclaration() &&
              nodePath.parent.type === "Program" &&
              startsWithCapital(nodePath.node?.id?.name)
            ) {
              name = nodePath.node?.id?.name;
            }
          },
        });

        if (!name) {
          console.log(
            chalk.red(
              "Failed to find name:",
              filePath.replace(componentBase, "")
            )
          );
        }

        traverse.default(ast, {
          enter(nodePath) {
            // if (needsObeserverUpdate) {
            //   if (
            //     nodePath.isCallExpression() &&
            //     nodePath.node.callee?.name === "observer"
            //   ) {
            //     needsObserverForHookImport = true;
            //     nodePath.replaceWith(
            //       types.callExpression(
            //         types.identifier("hookSafeObserver"),
            //         nodePath.node.arguments || []
            //       )
            //     );
            //   }

            //   // Remove import
            //   if (
            //     nodePath.isImportSpecifier() &&
            //     nodePath.node.imported?.name === "observer"
            //   ) {
            //     nodePath.remove();
            //   }
            // }

            // Translate JSX text
            if (nodePath.isJSXText()) {
              const indentifier = _.snakeCase(nodePath.node.value.trim());

              if (
                nodePath.node.value.trim() !== "" &&
                /[a-z]/i.test(nodePath.node.value)
              ) {
                hasTranslations = true;
                _.set(
                  translations,
                  `${name}.${indentifier}`,
                  nodePath.node.value.trim()
                );
                nodePath.node.value = `{${
                  isClassComp ? "this.props." : ""
                }t('${name}.${indentifier}')}`;
              }
            }

            // Translate JSX props
            if (nodePath.isStringLiteral()) {
              const indentifier = _.snakeCase(nodePath.node.value.trim());

              if (
                types.isConditionalExpression(nodePath.parent) &&
                types.isJSXExpressionContainer(
                  nodePath.parentPath.parentPath
                ) &&
                isMultiWord(nodePath.node.value)
              ) {
                hasTranslations = true;
                _.set(
                  translations,
                  `${name}.${indentifier}`,
                  nodePath.node.value.trim()
                );

                nodePath.replaceWith(
                  isClassComp
                    ? types.callExpression(
                        types.memberExpression(
                          types.memberExpression(
                            types.thisExpression(),
                            types.identifier("props"),
                            false
                          ),
                          types.identifier("t"),
                          false
                        ),
                        [types.stringLiteral(`${name}.${indentifier}`)]
                      )
                    : types.callExpression(types.identifier("t"), [
                        types.stringLiteral(`${name}.${indentifier}`),
                      ])
                );
              }

              const propWhitelist = ["text", "placeholder", "label"];

              if (types.isJSXAttribute(nodePath.parent)) {
                const shouldTranslate =
                  (!isPropValid.default(nodePath.parent.name?.name) &&
                    isMultiWord(nodePath.node.value)) ||
                  (propWhitelist.includes(nodePath.parent.name?.name) &&
                    nodePath.node.value.trim());

                if (!shouldTranslate) return;

                hasTranslations = true;
                _.set(
                  translations,
                  `${name}.${indentifier}`,
                  nodePath.node.value.trim()
                );

                if (isClassComp) {
                  nodePath.replaceWith(
                    types.jSXExpressionContainer(
                      types.callExpression(
                        types.memberExpression(
                          types.memberExpression(
                            types.thisExpression(),
                            types.identifier("props"),
                            false
                          ),
                          types.identifier("t"),
                          false
                        ),
                        [types.stringLiteral(`${name}.${indentifier}`)]
                      )
                    )
                  );
                } else {
                  nodePath.replaceWith(
                    types.jsxExpressionContainer(
                      types.callExpression(types.identifier("t"), [
                        types.stringLiteral(`${name}.${indentifier}`),
                      ])
                    )
                  );
                }
              }
            }

            // Add useTranslation hook (function components)
            if (
              !!name &&
              ((nodePath.isArrowFunctionExpression() &&
                nodePath.parent.id?.name === name) ||
                (nodePath.isFunctionDeclaration() &&
                  nodePath.node.id?.name === name))
            ) {
              if (HocOrHookAdded) return;
              if (types.isBlockStatement(nodePath.node.body)) {
                nodePath.node.body.body.unshift(
                  types.variableDeclaration("const", [
                    types.variableDeclarator(
                      types.objectPattern([
                        types.objectProperty(
                          types.identifier("t"),
                          types.identifier("t"),
                          false,
                          true
                        ),
                      ]),
                      types.callExpression(types.identifier("useTranslation"), [
                        types.stringLiteral(namespace),
                      ])
                    ),
                  ])
                );
                HocOrHookAdded = true;
              } else {
                nodePath.replaceWith(
                  types.arrowFunctionExpression(
                    nodePath.node.params || [],
                    types.blockStatement(
                      [
                        types.variableDeclaration("const", [
                          types.variableDeclarator(
                            types.objectPattern([
                              types.objectProperty(
                                types.identifier("t"),
                                types.identifier("t"),
                                false,
                                true
                              ),
                            ]),
                            types.callExpression(
                              types.identifier("useTranslation"),
                              [types.stringLiteral(namespace)]
                            )
                          ),
                        ]),
                        types.returnStatement(nodePath.node.body),
                      ],
                      []
                    ),
                    false
                  )
                );
                HocOrHookAdded = true;
              }
            }

            // Wrap with HOC (class components)
            if (isClassComp && nodePath.isExportDefaultDeclaration()) {
              if (HocOrHookAdded) return;
              nodePath.replaceWith(
                types.exportDefaultDeclaration(
                  types.callExpression(
                    types.callExpression(types.identifier("withTranslation"), [
                      types.stringLiteral(namespace),
                    ]),
                    [nodePath.node.declaration]
                  )
                )
              );
              HocOrHookAdded = true;
            }
          },
        });

        traverse.default(ast, {
          exit(nodePath) {
            if (!hasTranslations) return;

            // Add react-i18next import ** observerForHooks
            if (nodePath.isProgram()) {
              const identifier = types.identifier(
                `{${isClassComp ? "withTranslation" : "useTranslation"}}`
              );
              const importDefaultSpecifier =
                types.importDefaultSpecifier(identifier);
              const importDeclaration = types.importDeclaration(
                [importDefaultSpecifier],
                types.stringLiteral("react-i18next")
              );
              nodePath.unshiftContainer("body", importDeclaration);

              // if (needsObserverForHookImport) {
              //   const ofhLoc = componentBase + "Common/hookSafeObserver.js";
              //   const importLoc = path.relative(path.dirname(filePath), ofhLoc);

              //   nodePath.unshiftContainer(
              //     "body",
              //     types.importDeclaration(
              //       [
              //         types.importDefaultSpecifier(
              //           types.identifier("hookSafeObserver")
              //         ),
              //       ],
              //       types.stringLiteral(importLoc)
              //     )
              //   );
              // }
            }
          },
        });

        const output = generate.default(ast, code);

        if (hasTranslations) {
          // Check for known quirks

          // If component is wrapped in observer and is not a class component the hook will error
          // to fix use `observerForHooks` instead of `observer`
          if (code.includes("observer") && !code.includes("class ")) {
            hookErrors.push(filePath);
          }

          // End checks

          console.log(
            chalk.green("Translated:", filePath.replace(componentBase, ""))
          );

          await fs.outputFile(filePath, output.code, "utf-8");

          const transPath = path.join(
            translationBase,
            "en",
            `${namespace}.json`
          );
          const exists = fs.existsSync(transPath);

          if (exists) {
            translations = _.merge(translations, fs.readJSONSync(transPath));
          }

          await fs.outputFile(
            transPath,
            JSON.stringify(translations, null, "    "),
            "utf-8"
          );

          for (let al = 0; al < altLocales.length; al++) {
            const transAltPath = path.join(
              translationBase,
              "en",
              `${namespace}.json`
            );
            const existsAlt = fs.existsSync(transPath);

            if (existsAlt) {
              translations = _.merge(
                translations,
                fs.readJSONSync(transAltPath)
              );
            }

            const locale = altLocales[al];
            await fs.outputFile(
              path.join(translationBase, locale, `${namespace}.json`),
              JSON.stringify(
                mockTranslateDeep(translations, "german"),
                null,
                "    "
              ),
              "utf-8"
            );
          }
        }
      } catch (e) {
        console.log(
          chalk.red("Failed:", filePath.replace(componentBase, ""), e.message)
        );
      }
    }
  }

  if (hookErrors.length) {
    console.log(
      chalk.yellow("\n\nThe following files may contain observer errors:\n")
    );
    hookErrors.forEach((f) =>
      console.warn(chalk.yellow("File:", f.replace(componentBase, "")))
    );
  }
})();
