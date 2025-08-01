import * as Browser from "./build/types.js";
import { promises as fs } from "fs";
import { merge, resolveExposure, arrayToMap } from "./build/helpers.js";
import { type CompilerBehavior, emitWebIdl } from "./build/emitter.js";
import { convert } from "./build/widlprocess.js";
import { getExposedTypes } from "./build/expose.js";
import {
  getDeprecationData,
  getDocsData,
  getRemovalData,
} from "./build/bcd.js";
import { getInterfaceElementMergeData } from "./build/webref/elements.js";
import { getInterfaceToEventMap } from "./build/webref/events.js";
import { getWebidls } from "./build/webref/idl.js";
import jsonc from "jsonc-parser";
import { generateDescriptions } from "./build/mdn-comments.js";
import readPatches from "./build/patches.js";

function mergeNamesakes(filtered: Browser.WebIdl) {
  const targets = [
    ...Object.values(filtered.interfaces!.interface),
    ...Object.values(filtered.mixins!.mixin),
    ...filtered.namespaces!,
  ];
  for (const i of targets) {
    if (!i.properties || !i.properties.namesakes) {
      continue;
    }
    const { property } = i.properties!;
    for (const [prop] of Object.values(i.properties.namesakes)) {
      if (prop && !(prop.name in property)) {
        property[prop.name] = prop;
      }
    }
  }
}

interface EmitOptions {
  global: string[];
  name: string;
  outputFolder: URL;
  compilerBehavior: CompilerBehavior;
}

async function emitFlavor(
  webidl: Browser.WebIdl,
  forceKnownTypes: Set<string>,
  options: EmitOptions,
) {
  const exposed = getExposedTypes(webidl, options.global, forceKnownTypes);
  mergeNamesakes(exposed);
  exposed.events = webidl.events;

  const result = emitWebIdl(
    exposed,
    options.global[0],
    "",
    options.compilerBehavior,
  );
  await fs.writeFile(
    new URL(`${options.name}.generated.d.ts`, options.outputFolder),
    result,
  );

  const iterators = emitWebIdl(
    exposed,
    options.global[0],
    "sync",
    options.compilerBehavior,
  );
  await fs.writeFile(
    new URL(`${options.name}.iterable.generated.d.ts`, options.outputFolder),
    iterators,
  );

  const asyncIterators = emitWebIdl(
    exposed,
    options.global[0],
    "async",
    options.compilerBehavior,
  );
  await fs.writeFile(
    new URL(
      `${options.name}.asynciterable.generated.d.ts`,
      options.outputFolder,
    ),
    asyncIterators,
  );
}

async function emitDom() {
  const inputFolder = new URL("../inputfiles/", import.meta.url);
  const outputFolder = new URL("../generated/", import.meta.url);

  const overriddenItems = await readInputJSON("overridingTypes.jsonc");
  const addedItems = await readInputJSON("addedTypes.jsonc");
  const patches = await readPatches();
  const comments = await readInputJSON("comments.json");
  const deprecatedInfo = await readInputJSON("deprecatedMessage.json");
  const documentationFromMDN = await generateDescriptions();
  const removedItems = await readInputJSON("removedTypes.jsonc");

  async function readInputJSON(filename: string) {
    const content = await fs.readFile(new URL(filename, inputFolder), "utf8");
    return jsonc.parse(content);
  }

  const widlStandardTypes = (
    await Promise.all([...(await getWebidls()).entries()].map(convertWidl))
  ).filter((i) => i) as ReturnType<typeof convert>[];

  async function convertWidl([shortName, idl]: string[]) {
    let commentsMap: Record<string, string>;
    try {
      commentsMap = await readInputJSON(`idl/${shortName}.commentmap.json`);
    } catch {
      commentsMap = {};
    }
    commentCleanup(commentsMap);
    const result = convert(idl, commentsMap);
    return result;
  }

  function commentCleanup(commentsMap: Record<string, string>) {
    for (const key in commentsMap) {
      // Filters out phrases for nested comments as we retargets them:
      // "This operation receives a dictionary, which has these members:"
      commentsMap[key] = commentsMap[key].replace(/[,.][^,.]+:$/g, ".");
    }
  }

  function mergeApiDescriptions(
    idl: Browser.WebIdl,
    descriptions: { interfaces: { interface: Record<string, any> } },
  ) {
    const namespaces = arrayToMap(
      idl.namespaces!,
      (i) => i.name,
      (i) => i,
    );

    for (const [key, target] of Object.entries(namespaces)) {
      const descObject = descriptions.interfaces.interface[key];
      if (!descObject) continue;

      merge(target, descObject, { optional: true });
    }
    idl = merge(idl, descriptions, { optional: true });

    return idl;
  }

  function mergeDeprecatedMessage(
    idl: Browser.WebIdl,
    descriptions: Record<string, string>,
  ) {
    const namespaces = arrayToMap(
      idl.namespaces!,
      (i) => i.name,
      (i) => i,
    );
    for (const [key, value] of Object.entries(descriptions)) {
      const target = idl.interfaces!.interface[key] || namespaces[key];
      if (target) {
        target.deprecated = value;
      }
    }
    return idl;
  }

  /// Load the input file
  let webidl: Browser.WebIdl = {
    events: await getInterfaceToEventMap(),
  };

  for (const w of widlStandardTypes) {
    webidl = merge(webidl, w.browser, { shallow: true });
  }
  for (const w of widlStandardTypes) {
    for (const partial of w.partialInterfaces) {
      // Fallback to mixins before every spec migrates to `partial interface mixin`.
      const base =
        webidl.interfaces!.interface[partial.name] ||
        webidl.mixins!.mixin[partial.name];
      if (base) {
        if (base.exposed) resolveExposure(partial, base.exposed);
        merge(base.constants, partial.constants, { shallow: true });
        merge(base.methods, partial.methods, { shallow: true });
        merge(base.properties, partial.properties, { shallow: true });
      }
    }
    for (const partial of w.partialMixins) {
      const base = webidl.mixins!.mixin[partial.name];
      if (base) {
        if (base.exposed) resolveExposure(partial, base.exposed);
        merge(base.constants, partial.constants, { shallow: true });
        merge(base.methods, partial.methods, { shallow: true });
        merge(base.properties, partial.properties, { shallow: true });
      }
    }
    for (const partial of w.partialDictionaries) {
      const base = webidl.dictionaries!.dictionary[partial.name];
      if (base) {
        merge(base.members, partial.members, { shallow: true });
      }
    }
    for (const partial of w.partialNamespaces) {
      const base = webidl.namespaces?.find((n) => n.name === partial.name);
      if (base) {
        if (base.exposed) resolveExposure(partial, base.exposed);
        merge(base.methods, partial.methods, { shallow: true });
        merge(base.properties, partial.properties, { shallow: true });
      }
    }
    for (const include of w.includes) {
      const target = webidl.interfaces!.interface[include.target];
      if (target) {
        if (!target.implements) {
          target.implements = [include.includes];
        } else {
          target.implements.push(include.includes);
        }
      }
    }
  }
  webidl = merge(webidl, await getInterfaceElementMergeData());

  webidl = merge(webidl, getDeprecationData(webidl));
  webidl = merge(webidl, getRemovalData(webidl));
  webidl = merge(webidl, getDocsData(webidl));
  webidl = prune(webidl, removedItems);
  webidl = mergeApiDescriptions(webidl, documentationFromMDN);
  webidl = merge(webidl, addedItems);
  webidl = merge(webidl, overriddenItems);
  webidl = merge(webidl, patches);
  webidl = merge(webidl, comments);
  webidl = mergeDeprecatedMessage(webidl, deprecatedInfo);
  for (const name in webidl.interfaces!.interface) {
    const i = webidl.interfaces!.interface[name];
    if (i.overrideExposed) {
      resolveExposure(i, i.overrideExposed!, true);
    }
  }

  const transferables = Object.values(
    webidl.interfaces?.interface ?? {},
  ).filter((i) => i.transferable);

  webidl = merge(webidl, {
    typedefs: {
      typedef: [
        {
          name: "Transferable",
          type: [
            ...transferables.map((v) => ({ type: v.name })),
            { type: "ArrayBuffer" },
          ],
        },
      ],
    },
  });

  const knownTypes = await readInputJSON("knownTypes.json");

  interface Variation {
    outputFolder: URL;
    compilerBehavior: CompilerBehavior;
  }

  const emitVariations: Variation[] = [
    // ts5.7 (and later)
    // - introduced generic typed arrays over `ArrayBufferLike`
    {
      outputFolder,
      compilerBehavior: {
        useIteratorObject: true,
        allowUnrelatedSetterType: true,
        useGenericTypedArrays: true,
      },
    },
    // ts5.6
    // - introduced support for `IteratorObject`/Iterator helpers and unrelated setter types
    {
      outputFolder: new URL("./ts5.6/", outputFolder),
      compilerBehavior: {
        useIteratorObject: true,
        allowUnrelatedSetterType: true,
      },
    },
    // ts5.5 (and earlier)
    {
      outputFolder: new URL("./ts5.5/", outputFolder),
      compilerBehavior: {}, // ts5.5 does not support `IteratorObject` or unrelated setter types
    },
  ];

  for (const { outputFolder, compilerBehavior } of emitVariations) {
    // Create output folder
    await fs.mkdir(outputFolder, {
      // Doesn't need to be recursive, but this helpfully ignores EEXIST
      recursive: true,
    });

    emitFlavor(webidl, new Set(knownTypes.Window), {
      name: "dom",
      global: ["Window"],
      outputFolder,
      compilerBehavior,
    });
    emitFlavor(webidl, new Set(knownTypes.Worker), {
      name: "webworker",
      global: ["Worker", "DedicatedWorker", "SharedWorker", "ServiceWorker"],
      outputFolder,
      compilerBehavior,
    });
    emitFlavor(webidl, new Set(knownTypes.Worker), {
      name: "sharedworker",
      global: ["SharedWorker", "Worker"],
      outputFolder,
      compilerBehavior,
    });
    emitFlavor(webidl, new Set(knownTypes.Worker), {
      name: "serviceworker",
      global: ["ServiceWorker", "Worker"],
      outputFolder,
      compilerBehavior,
    });
    emitFlavor(webidl, new Set(knownTypes.Worklet), {
      name: "audioworklet",
      global: ["AudioWorklet", "Worklet"],
      outputFolder,
      compilerBehavior,
    });
  }

  function prune(
    obj: Browser.WebIdl,
    template: Partial<Browser.WebIdl>,
  ): Browser.WebIdl {
    return filterByNull(obj, template);

    function filterByNull(obj: any, template: any) {
      if (!template) return obj;
      const filtered = Array.isArray(obj) ? obj.slice(0) : { ...obj };
      for (const k in template) {
        if (!obj[k]) {
          console.warn(
            `removedTypes.json has a redundant field ${k} in ${JSON.stringify(
              template,
            ).slice(0, 100)}`,
          );
        } else if (Array.isArray(template[k])) {
          if (!Array.isArray(obj[k])) {
            throw new Error(
              `Removal template ${k} is an array but the original field is not`,
            );
          }
          // template should include strings
          filtered[k] = obj[k].filter((item: any) => {
            const name = typeof item === "string" ? item : item.name;
            return !template[k].includes(name);
          });
          if (filtered[k].length !== obj[k].length - template[k].length) {
            const differences = template[k].filter(
              (t: any) => !obj[k].includes(t),
            );
            console.warn(
              `removedTypes.json has redundant array items: ${differences}`,
            );
          }
        } else if (template[k] !== null) {
          filtered[k] = filterByNull(obj[k], template[k]);
        } else {
          if (obj[k].exposed === "") {
            console.warn(
              `removedTypes.json removes ${k} that has already been disabled by BCD.`,
            );
          }
          delete filtered[k];
        }
      }
      return filtered;
    }
  }
}

await emitDom();
