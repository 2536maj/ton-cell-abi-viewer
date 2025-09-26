import { createEffect, createSignal } from 'solid-js'
import './App.css'
import { Cell, Dictionary } from '@ton/core'
import { Address } from '@ton/core'
import { Buffer } from 'buffer'
import { parseWithPayloads } from '@truecarry/tlb-abi'
import { stringify } from 'yaml'
import { parseUsingBlockTypes } from './BlockParser'
import { ExampleCell } from './Example'
import { decompileAll, AssemblerWriter } from '@scaleton/tvm-disassembler';
import { parseTLB } from '@ton-community/tlb-runtime'

type OutputFormat = 'yaml' | 'json' | 'plain' | 'code'

const sanitizeObject = (obj: any) => {
  if (obj instanceof Cell) {
    return obj.toBoc().toString('hex')
  }

  if (obj instanceof Address) {
    return obj.toString()
  }

  if (obj instanceof Buffer) {
    return obj.toString('hex')
  }

  if (typeof obj === 'object' && obj !== null) {
    const sanitized: any = {}
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        sanitized[key] = sanitizeObject(obj[key])
      }
    }
    return sanitized
  }

  if (typeof obj === 'bigint') {
    return obj.toString()
  }

  if (typeof obj === 'function') {
    return undefined
  }

  return obj
}


function parseCell(cell: Cell, tlb?: string) {
  let parsed: any

  try {
    parsed = parseRuntimeTlb(cell, tlb ?? '')
    if (parsed) {
      return parsed
    }
  } catch (e) {
    console.error(e)
  }

  try {
    parsed = parseWithPayloads(cell.beginParse())
    if (parsed) {
      console.log('parsed', parsed)
      if (parsed?.data?.kind === 'TextComment') {
        // text parser
        try {
          if (cell.bits.length > 32) {
            const slice = cell.beginParse()
            const op = slice.loadUint(32)
            if (op === 0x00000000) {
              const text = slice.loadStringTail()
              return {
                kind: 'Comment',
                text: text,
              }
            }
          }
          if (parsed) {
            return parsed
          }
        } catch (e) {
          console.error(e)
        }
      }
      return parsed
    }
  } catch (e) {
    console.error(e)
  }

  try {
    parsed = parseUsingBlockTypes(cell)
    if (parsed) {
      return parsed
    }
  } catch (e) {
    console.error(e)
  }

  return undefined
}

function parseRuntimeTlb(cell: Cell, tlb: string) {
  try {
    const runtime = parseTLB(tlb)
    const unpack = runtime.deserialize(cell)
    if (unpack.success) {
      return unpack
    }
  } catch (e) {
    //
  }

  return undefined
}

export function replaceCellPayload<T>(obj: T, tlb?: string): {
  data: T
  hasChanges: boolean
} {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return {
      data: obj,
      hasChanges: false
    }
  }

  if (obj instanceof Dictionary) {
    const dictData = obj.keys().reduce((acc, key) => {
      acc[key] = obj.get(key)
      return acc
    }, {} as any)
    return {
      data: dictData,
      hasChanges: true
    }
  }

  // Direct JettonPayload case
  if (obj instanceof Cell) {
    try {
      const parsedCell = parseCell(obj, tlb)
      if (parsedCell) {
        return {
          data: {
            data: obj.toBoc().toString('hex'),
            parsed: parsedCell,
          } as any,
          hasChanges: true
        }
      }

      return {
        data: obj,
        hasChanges: false
      }
    } catch (e) {
      // Not a valid Jetton payload, leave as is
    }
    return {
      data: obj,
      hasChanges: false
    }
  }

  // Array case
  if (Array.isArray(obj)) {
    const replaced = obj.map(item => replaceCellPayload(item, tlb))
    const hasChanges = replaced.some(item => item.hasChanges)
    return {
      data: hasChanges
        ? replaced.map(item => item.data) as any
        : obj,
      hasChanges: hasChanges
    }
  }

  // Regular object case
  let hasChanges = false;
  const result = { ...obj } as any;

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const { data, hasChanges: hasChangesInner } = replaceCellPayload((obj as any)[key], tlb);
      if (hasChangesInner) {
        hasChanges = true;
        result[key] = data;
      }
    }
  }

  // Return original object if no changes were made
  return {
    data: hasChanges ? result : obj,
    hasChanges: hasChanges
  }
}

function App() {
  const [input, setInput] = createSignal('')
  const [output, setOutput] = createSignal('')
  const [error, setError] = createSignal('')
  const [isLoading, setIsLoading] = createSignal(false)
  const [format, setFormat] = createSignal<OutputFormat>('yaml')
  const [tlb, setTlb] = createSignal('')

  const formatOutput = (data: any) => {
    if (format() === 'json') {
      return JSON.stringify(data, null, 2)
    }
    if (format() === 'plain') {
      if (typeof data === 'string') {
        return data
      }
      return JSON.stringify(data)
    }
    if (format() === 'code') {
      try {
        let cell: Cell | undefined
        try {
          cell = Cell.fromBase64(input())
        } catch (e) {
          // Try hex format if base64 fails
        }
        if (!cell) {
          try {
            cell = Cell.fromBoc(Buffer.from(input(), 'hex'))[0]
          } catch (e) {
            //
          }
        }

        if (!cell) {
          return stringify(data)
        }

        const ast = decompileAll({ src: cell }); // Build AST
        const assembler = AssemblerWriter.write(ast); // Generate assembler from AST
        return assembler
      } catch (e) {
        console.error(e)
        return stringify(data)
      }
    }
    return stringify(data)
  }

  const handleParse = (input: string) => {
    if (!input.trim()) {
      setError('Please enter a cell to parse')
      return
    }

    setIsLoading(true)
    setError('')
    setOutput('')

    try {
      let cell: Cell | undefined
      try {
        cell = Cell.fromBase64(input)
      } catch (e) {
        // Try hex format if base64 fails
      }
      if (!cell) {
        try {
          cell = Cell.fromBoc(Buffer.from(input, 'hex'))[0]
        } catch (e) {
          setError('Invalid cell format. Please provide a valid base64 or hex encoded cell.')
          return
        }
      }

      let parsed = parseCell(cell, tlb())
      while (true) {
        const { data, hasChanges } = replaceCellPayload(parsed, tlb())
        parsed = data
        if (!hasChanges) {
          break
        }
      }
      if (parsed) {
        const sanitized = sanitizeObject(parsed)
        setOutput(sanitized)
      } else {
        setOutput(cell.toString())
        setFormat('plain')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse cell')
    } finally {
      setIsLoading(false)
    }
  }

  createEffect(() => {
    handleParse(input())
  })

  const openInJsonHero = () => {
    const jsonData = JSON.stringify(output());
    fetch('https://jsonhero.io/api/create.json', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'TON Cell Data',
        content: JSON.parse(jsonData),
        readOnly: false
      })
    }).then(response => {
      if (response.ok) {
        return response.json();
      }
    }).then(data => {
      if (data?.location) {
        window.open(data.location, '_blank');
      }
    });
  }

  return (
    <div class="container">
      <header>
        <h1>TON Cell ABI Viewer</h1>
        <p class="subtitle">Parse and view TON smart contract cells in a human-readable format</p>
      </header>

      <main>
        <section class="input-section">
          <div class="input-header">
            <h2>Input Cell</h2>
            <div class="format-info">
              <span class="format-badge">Base64</span>
              <span class="format-badge">Hex</span>
            </div>
          </div>

          <div class="input-group">
            <textarea
              value={input()}
              onInput={(e) => setInput(e.currentTarget.value)}
              placeholder="Paste your cell here (base64 or hex format)..."
              rows="5"
              disabled={isLoading()}
            />
            {/* <div class="button-group">
              <button 
                onClick={handleParse} 
                disabled={isLoading() || !input().trim()}
                class={isLoading() ? 'loading' : ''}
              >
                {isLoading() ? 'Parsing...' : 'Parse Cell'}
              </button>
              <button 
                onClick={handleClear}
                class="secondary"
                disabled={isLoading()}
              >
                Clear
              </button>
            </div> */}
          </div>

          <div class="input-group flex flex-col">
            <div>Custom TLB:</div>
            <textarea
              value={tlb()}
              onInput={(e) => setTlb(e.currentTarget.value)}
              placeholder="Paste your TLB here..."
              rows="5"
              class='flex'
            />
          </div>

          <div class="example-cell-button-container">
            <button onClick={() => setInput(ExampleCell)} class="example-cell-button">Use example cell</button>
          </div>
        </section>

        {error() && (
          <section class="error-section">
            <div class="error">
              <span class="error-icon">⚠️</span>
              {error()}
            </div>
          </section>
        )}

        {output() && (
          <section class="output-section">
            <div class="output-header">
              <div class="output-header-content">
                <h2>Parsed Result</h2>
                <div class="format-selector">
                  <button
                    class={`format-button ${format() === 'yaml' ? 'active' : ''}`}
                    onClick={() => {
                      setFormat('yaml')
                    }}
                  >
                    YAML
                  </button>
                  <button
                    class={`format-button ${format() === 'json' ? 'active' : ''}`}
                    onClick={() => {
                      setFormat('json')
                    }}
                  >
                    JSON
                  </button>
                  <button
                    class={`format-button ${format() === 'plain' ? 'active' : ''}`}
                    onClick={() => {
                      setFormat('plain')
                    }}
                  >
                    Plain
                  </button>
                  <button
                    class={`format-button ${format() === 'code' ? 'active' : ''}`}
                    onClick={() => {
                      setFormat('code')
                    }}
                  >
                    Code
                  </button>
                </div>
              </div>

              <div class="button-group">
                <div class="copy-button" onClick={() => navigator.clipboard.writeText(output())}>
                  Copy to Clipboard
                </div>
                <div
                  class="copy-button"
                  onClick={openInJsonHero}
                >
                  Open in JSONHero
                </div>
              </div>
            </div>
            <div class="output-container">
              <code
                class="output-textarea"
              >
                <pre>
                  {formatOutput(output())}
                </pre>
              </code>
            </div>
          </section>
        )}
      </main>

      <footer>
        <p>Built with @ton/core, @truecarry/tlb-abi and SolidJS</p>
        <p>
          <a href="https://github.com/TrueCarry/ton-cell-abi-viewer" target="_blank" rel="noopener noreferrer">
            View on GitHub
          </a>
        </p>
      </footer>
    </div>
  )
}

export default App
