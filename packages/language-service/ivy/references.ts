/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {TmplAstBoundAttribute, TmplAstTextAttribute, TmplAstVariable} from '@angular/compiler';
import {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import {absoluteFrom, absoluteFromSourceFile, AbsoluteFsPath} from '@angular/compiler-cli/src/ngtsc/file_system';
import {DirectiveSymbol, SymbolKind, TemplateTypeChecker, TypeCheckingProgramStrategy} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import {ExpressionIdentifier, hasExpressionIdentifier} from '@angular/compiler-cli/src/ngtsc/typecheck/src/comments';
import * as ts from 'typescript';

import {getTargetAtPosition, TargetNodeKind} from './template_target';
import {findTightestNode} from './ts_utils';
import {getDirectiveMatchesForAttribute, getDirectiveMatchesForElementTag, getTemplateInfoAtPosition, isWithin, TemplateInfo, toTextSpan} from './utils';

export class ReferenceBuilder {
  private readonly ttc = this.compiler.getTemplateTypeChecker();

  constructor(
      private readonly strategy: TypeCheckingProgramStrategy,
      private readonly tsLS: ts.LanguageService, private readonly compiler: NgCompiler) {}

  get(filePath: string, position: number): ts.ReferenceEntry[]|undefined {
    this.ttc.generateAllTypeCheckBlocks();
    const templateInfo = getTemplateInfoAtPosition(filePath, position, this.compiler);
    return templateInfo !== undefined ?
        this.getReferencesAtTemplatePosition(templateInfo, position) :
        this.getReferencesAtTypescriptPosition(filePath, position);
  }

  private getReferencesAtTemplatePosition({template, component}: TemplateInfo, position: number):
      ts.ReferenceEntry[]|undefined {
    // Find the AST node in the template at the position.
    const positionDetails = getTargetAtPosition(template, position);
    if (positionDetails === null) {
      return undefined;
    }

    const nodes = positionDetails.context.kind === TargetNodeKind.TwoWayBindingContext ?
        positionDetails.context.nodes :
        [positionDetails.context.node];

    const references: ts.ReferenceEntry[] = [];
    for (const node of nodes) {
      // Get the information about the TCB at the template position.
      const symbol = this.ttc.getSymbolOfNode(node, component);
      if (symbol === null) {
        continue;
      }

      switch (symbol.kind) {
        case SymbolKind.Directive:
        case SymbolKind.Template:
          // References to elements, templates, and directives will be through template references
          // (#ref). They shouldn't be used directly for a Language Service reference request.
          break;
        case SymbolKind.Element: {
          const matches = getDirectiveMatchesForElementTag(symbol.templateNode, symbol.directives);
          references.push(...this.getReferencesForDirectives(matches) ?? []);
          break;
        }
        case SymbolKind.DomBinding: {
          // Dom bindings aren't currently type-checked (see `checkTypeOfDomBindings`) so they don't
          // have a shim location. This means we can't match dom bindings to their lib.dom
          // reference, but we can still see if they match to a directive.
          if (!(node instanceof TmplAstTextAttribute) && !(node instanceof TmplAstBoundAttribute)) {
            break;
          }
          const directives = getDirectiveMatchesForAttribute(
              node.name, symbol.host.templateNode, symbol.host.directives);
          references.push(...this.getReferencesForDirectives(directives) ?? []);
          break;
        }
        case SymbolKind.Reference: {
          const {shimPath, positionInShimFile} = symbol.referenceVarLocation;
          references.push(
              ...this.getReferencesAtTypescriptPosition(shimPath, positionInShimFile) ?? []);
          break;
        }
        case SymbolKind.Variable: {
          const {positionInShimFile: initializerPosition, shimPath} = symbol.initializerLocation;
          const localVarPosition = symbol.localVarLocation.positionInShimFile;

          if ((node instanceof TmplAstVariable)) {
            if (node.valueSpan !== undefined && isWithin(position, node.valueSpan)) {
              // In the valueSpan of the variable, we want to get the reference of the initializer.
              references.push(
                  ...this.getReferencesAtTypescriptPosition(shimPath, initializerPosition) ?? []);
            } else if (isWithin(position, node.keySpan)) {
              // In the keySpan of the variable, we want to get the reference of the local variable.
              references.push(
                  ...this.getReferencesAtTypescriptPosition(shimPath, localVarPosition) ?? []);
            }
          } else {
            // If the templateNode is not the `TmplAstVariable`, it must be a usage of the variable
            // somewhere in the template.
            references.push(
                ...this.getReferencesAtTypescriptPosition(shimPath, localVarPosition) ?? []);
          }

          break;
        }
        case SymbolKind.Input:
        case SymbolKind.Output: {
          // TODO(atscott): Determine how to handle when the binding maps to several inputs/outputs
          const {shimPath, positionInShimFile} = symbol.bindings[0].shimLocation;
          references.push(
              ...this.getReferencesAtTypescriptPosition(shimPath, positionInShimFile) ?? []);
          break;
        }
        case SymbolKind.Pipe:
        case SymbolKind.Expression: {
          const {shimPath, positionInShimFile} = symbol.shimLocation;
          references.push(
              ...this.getReferencesAtTypescriptPosition(shimPath, positionInShimFile) ?? []);
          break;
        }
      }
    }
    if (references.length === 0) {
      return undefined;
    }

    return references;
  }

  private getReferencesForDirectives(directives: Set<DirectiveSymbol>):
      ts.ReferenceEntry[]|undefined {
    const allDirectiveRefs: ts.ReferenceEntry[] = [];
    for (const dir of directives.values()) {
      const dirClass = dir.tsSymbol.valueDeclaration;
      if (dirClass === undefined || !ts.isClassDeclaration(dirClass) ||
          dirClass.name === undefined) {
        continue;
      }

      const dirFile = dirClass.getSourceFile().fileName;
      const dirPosition = dirClass.name.getStart();
      const directiveRefs = this.getReferencesAtTypescriptPosition(dirFile, dirPosition);
      if (directiveRefs !== undefined) {
        allDirectiveRefs.push(...directiveRefs);
      }
    }

    return allDirectiveRefs.length > 0 ? allDirectiveRefs : undefined;
  }

  private getReferencesAtTypescriptPosition(fileName: string, position: number):
      ts.ReferenceEntry[]|undefined {
    const refs = this.tsLS.getReferencesAtPosition(fileName, position);
    if (refs === undefined) {
      return undefined;
    }

    const entries: ts.ReferenceEntry[] = [];
    for (const ref of refs) {
      if (this.ttc.isTrackedTypeCheckFile(absoluteFrom(ref.fileName))) {
        const entry = this.convertToTemplateReferenceEntry(ref, this.ttc);
        if (entry !== null) {
          entries.push(entry);
        }
      } else {
        entries.push(ref);
      }
    }
    return entries;
  }

  private convertToTemplateReferenceEntry(
      shimReferenceEntry: ts.ReferenceEntry,
      templateTypeChecker: TemplateTypeChecker): ts.ReferenceEntry|null {
    const sf = this.strategy.getProgram().getSourceFile(shimReferenceEntry.fileName);
    if (sf === undefined) {
      return null;
    }
    const tcbNode = findTightestNode(sf, shimReferenceEntry.textSpan.start);
    if (tcbNode === undefined ||
        hasExpressionIdentifier(sf, tcbNode, ExpressionIdentifier.EVENT_PARAMETER)) {
      // If the reference result is the $event parameter in the subscribe/addEventListener function
      // in the TCB, we want to filter this result out of the references. We really only want to
      // return references to the parameter in the template itself.
      return null;
    }

    // TODO(atscott): Determine how to consistently resolve paths. i.e. with the project serverHost
    // or LSParseConfigHost in the adapter. We should have a better defined way to normalize paths.
    const mapping = templateTypeChecker.getTemplateMappingAtShimLocation({
      shimPath: absoluteFrom(shimReferenceEntry.fileName),
      positionInShimFile: shimReferenceEntry.textSpan.start,
    });
    if (mapping === null) {
      return null;
    }
    const {templateSourceMapping, span} = mapping;

    let templateUrl: AbsoluteFsPath;
    if (templateSourceMapping.type === 'direct') {
      templateUrl = absoluteFromSourceFile(templateSourceMapping.node.getSourceFile());
    } else if (templateSourceMapping.type === 'external') {
      templateUrl = absoluteFrom(templateSourceMapping.templateUrl);
    } else {
      // This includes indirect mappings, which are difficult to map directly to the code location.
      // Diagnostics similarly return a synthetic template string for this case rather than a real
      // location.
      return null;
    }

    return {
      ...shimReferenceEntry,
      fileName: templateUrl,
      textSpan: toTextSpan(span),
    };
  }
}
