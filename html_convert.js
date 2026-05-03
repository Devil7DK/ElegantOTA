import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";

const COMPRESSION_TYPE = "gzip";
const DEFAULT_ENCODING = "utf-8";

const BYTES_PER_LINE = 30; // Match the original formatting of 30 bytes per line in elop.cpp

/**
 * Decompresses a byte array using gzip compression
 * @param {number[]} byteArray - Array of compressed bytes
 * @returns {Promise<string>} Decompressed string content
 */
async function decodeBytes(byteArray) {
  try {
    const compressedData = new Uint8Array(byteArray);
    const compressedBlob = new Blob([compressedData], {
      type: `application/${COMPRESSION_TYPE}`,
    });

    const ds = new DecompressionStream(COMPRESSION_TYPE);
    const decompressedStream = compressedBlob.stream().pipeThrough(ds);
    const reader = decompressedStream.getReader();

    let decompressedData = "";
    let result;

    while ((result = await reader.read()) && !result.done) {
      decompressedData += new TextDecoder().decode(result.value);
    }

    return decompressedData;
  } catch (error) {
    throw new Error(`Failed to decompress data: ${error.message}`);
  }
}

/**
 * Compresses a string using gzip compression
 * @param {string} inputString - String to compress
 * @returns {Promise<Uint8Array>} Compressed byte array
 */
async function encodeString(inputString) {
  try {
    const encoder = new TextEncoder();
    const inputData = encoder.encode(inputString);

    const cs = new CompressionStream(COMPRESSION_TYPE);
    const compressedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(inputData);
        controller.close();
      },
    }).pipeThrough(cs);

    const reader = compressedStream.getReader();
    const chunks = [];
    let result;

    while ((result = await reader.read()) && !result.done) {
      chunks.push(result.value);
    }

    const compressedData = new Uint8Array(
      chunks.reduce((acc, chunk) => {
        const newAcc = new Uint8Array(acc.length + chunk.length);
        newAcc.set(acc);
        newAcc.set(chunk, acc.length);
        return newAcc;
      }, new Uint8Array()),
    );

    return compressedData;
  } catch (error) {
    throw new Error(`Failed to compress string: ${error.message}`);
  }
}

/**
 * Validates command line arguments
 * @param {string[]} args - Command line arguments
 * @returns {string} Validated action ('encode' or 'decode')
 */
function validateAction(args) {
  const action = args[2];
  if (!action || (action !== "encode" && action !== "decode")) {
    throw new Error("Invalid action. Use 'encode' or 'decode'.");
  }
  return action;
}

/**
 * Checks if a file exists and throws descriptive error if not
 * @param {string} filePath - Path to check
 * @param {string} description - Description for error message
 */
function validateFileExists(filePath, description) {
  if (!existsSync(filePath)) {
    throw new Error(`${description} not found: ${filePath}`);
  }
}

/**
 * Groups an array into chunks of specified size
 * @param {Uint8Array} data - Data to group
 * @param {number} chunkSize - Size of each chunk
 * @returns {number[][]} Array of chunks
 */
function groupBytes(data, chunkSize = BYTES_PER_LINE) {
  const groupedBytes = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    groupedBytes.push(Array.from(data.slice(i, i + chunkSize)));
  }
  return groupedBytes;
}

/**
 * Generates C++ content with compressed HTML data
 * @param {Uint8Array} compressedData - Compressed data
 * @returns {string} C++ file content
 */
function generateCppContent(compressedData) {
  const groupedBytes = groupBytes(compressedData);

  const cppContent = `#include "elop.h" 

const uint8_t ELEGANT_HTML[${compressedData.length}] PROGMEM = { 
${groupedBytes
  .map(
    (group, index, arr) =>
      group.join(",") + (index < arr.length - 1 ? "," : ""),
  )
  .join("\n")}
};
`;

  return cppContent;
}

/**
 * Generates C++ header content for the compressed HTML data
 * @param {number} compressedDataLength - Length of the compressed data
 * @returns {string} C++ header file content
 */
function generateHeaderContent(compressedDataLength) {
  return `#ifndef elop_h
#define elop_h

#include <Arduino.h>

extern const uint8_t ELEGANT_HTML[${compressedDataLength}];

#endif
`;
}

/**
 * Main function to handle encoding/decoding operations
 */
async function main() {
  try {
    const htmlFilePath = resolve(process.cwd(), "elop.html");
    const cppFilePath = resolve(process.cwd(), "src", "elop.cpp");
    const headerFilePath = resolve(process.cwd(), "src", "elop.h");

    const action = validateAction(process.argv);

    if (action === "encode") {
      await validateFileExists(htmlFilePath, "HTML file");

      console.log(`Reading HTML file: ${htmlFilePath}`);
      const htmlContent = await readFile(htmlFilePath, DEFAULT_ENCODING);

      console.log("Compressing HTML content...");
      const compressedData = await encodeString(htmlContent);

      const cppContent = generateCppContent(compressedData);
      const headerContent = generateHeaderContent(compressedData.length);

      console.log(`Writing compressed data to: ${cppFilePath}`);
      await writeFile(cppFilePath, cppContent, DEFAULT_ENCODING);

      console.log(`Writing header file to: ${headerFilePath}`);
      await writeFile(headerFilePath, headerContent, DEFAULT_ENCODING);

      console.log(`✅ Successfully encoded HTML to ${cppFilePath}`);
      console.log(
        `📊 Compression ratio: ${htmlContent.length} -> ${compressedData.length} bytes (${((1 - compressedData.length / htmlContent.length) * 100).toFixed(1)}% reduction)`,
      );
    } else if (action === "decode") {
      await validateFileExists(cppFilePath, "C++ file");

      console.log(`Reading C++ file: ${cppFilePath}`);
      const cppContent = await readFile(cppFilePath, DEFAULT_ENCODING);

      const byteArrayMatch = cppContent.match(
        /const uint8_t ELEGANT_HTML\[\d+\] PROGMEM = \{([^}]*)\}/,
      );

      if (!byteArrayMatch) {
        throw new Error(
          "Byte array not found in the C++ file. Expected format: 'const uint8_t ELEGANT_HTML[...] PROGMEM = {...}'",
        );
      }

      console.log("Extracting byte array...");
      const byteArrayString = byteArrayMatch[1].trim();
      const byteArray = byteArrayString
        .split(",")
        .map((byte) => parseInt(byte.trim(), 10))
        .filter((num) => !isNaN(num)); // Filter out any invalid numbers

      if (byteArray.length === 0) {
        throw new Error("No valid byte data found in the C++ file.");
      }

      console.log("Decompressing byte array...");
      const decompressedHtml = await decodeBytes(byteArray);

      console.log(`Writing decompressed HTML to: ${htmlFilePath}`);
      await writeFile(htmlFilePath, decompressedHtml, DEFAULT_ENCODING);

      console.log(`✅ Successfully decoded C++ data to ${htmlFilePath}`);
      console.log(`📊 Decompressed size: ${decompressedHtml.length} bytes`);
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`💥 Unexpected error: ${error.message}`);
  console.error("Stack trace:", error.stack);
  process.exit(1);
});
