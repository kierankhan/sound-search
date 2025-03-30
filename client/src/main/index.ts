import { app, shell, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { join } from 'path'
import { promises as fsPromises } from 'fs'
import fs from 'fs'
import path from 'path'
import * as mm from 'music-metadata';
// import faiss from 'faiss-node'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// Import FAISS - we'll handle this with require to avoid TypeScript issues
const faiss = require('faiss-node')
const sound = require("sound-play");

async function debugFileSystem() {
  const userDataPath = getUserDataPath();
  const indexPath = getIndexPath();
  const metadataPath = getMetadataPath();
  
  console.log('==== DEBUGGING FILE SYSTEM ====');
  console.log(`User data path: ${userDataPath}`);
  console.log(`Index path: ${indexPath}`);
  console.log(`Metadata path: ${metadataPath}`);

  // Check if directories exist
  try {
    const userDataStats = await fsPromises.stat(userDataPath);
    console.log(`User data directory exists: ${userDataStats.isDirectory()}`);
  } catch (error) {
    console.log(`Error checking user data directory: ${error.message}`);
    
    // Try to create it
    try {
      await fsPromises.mkdir(userDataPath, { recursive: true });
      console.log(`Created user data directory`);
    } catch (createError) {
      console.log(`Failed to create user data directory: ${createError.message}`);
    }
  }

  // Check if we can write a test file
  const testFilePath = path.join(userDataPath, 'test-write.txt');
  try {
    await fsPromises.writeFile(testFilePath, 'Test write operation');
    console.log(`Successfully wrote test file: ${testFilePath}`);
    
    // Try to read it back
    const content = await fsPromises.readFile(testFilePath, 'utf-8');
    console.log(`Successfully read test file, content: ${content}`);
    
    // Clean up
    await fsPromises.unlink(testFilePath);
    console.log(`Successfully deleted test file`);
  } catch (error) {
    console.log(`Error with test file operations: ${error.message}`);
  }

  // Check if the index file exists
  try {
    const indexStats = await fsPromises.stat(indexPath);
    console.log(`Index file exists: true, size: ${indexStats.size} bytes`);
  } catch (error) {
    console.log(`Index file does not exist: ${error.message}`);
  }

  // Check if the metadata file exists
  try {
    const metadataStats = await fsPromises.stat(metadataPath);
    console.log(`Metadata file exists: true, size: ${metadataStats.size} bytes`);
    
    // Try to read it
    try {
      const content = await fsPromises.readFile(metadataPath, 'utf-8');
      console.log(`Metadata file content (first 100 chars): ${content.substring(0, 100)}...`);
      console.log(`Total metadata entries: ${JSON.parse(content).length}`);
    } catch (readError) {
      console.log(`Error reading metadata file: ${readError.message}`);
    }
  } catch (error) {
    console.log(`Metadata file does not exist: ${error.message}`);
  }

  console.log('==== END DEBUGGING FILE SYSTEM ====');
}

// Define paths for storing index and metadata
const getUserDataPath = () => app.getPath('userData')
const getIndexPath = () => path.join(getUserDataPath(), 'faiss-index.bin')
const getMetadataPath = () => path.join(getUserDataPath(), 'samples-metadata.json')
console.log(getIndexPath)

// Save and load functions for filesystem instead of electron-store
// Update the saveIndex function to handle different FAISS implementations
async function saveIndex(index) {
  try {
    console.log(`Attempting to save index to: ${getIndexPath()}`);
    
    // Use write method as shown in docs
    index.write(getIndexPath());
    console.log(`Successfully wrote index file using write() method`);
    
    // Verify the file was written
    try {
      const stats = await fsPromises.stat(getIndexPath());
      console.log(`Verified index file exists with size: ${stats.size} bytes`);
      return true;
    } catch (statError) {
      console.error(`Error verifying index file: ${statError.message}`);
      return false;
    }
  } catch (error) {
    console.error(`Error saving index: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

const setupAudioProtocol = () => {
  protocol.registerFileProtocol('audio', (request, callback) => {
    const filePath = decodeURIComponent(request.url.slice('audio://'.length))
    try {
      return callback({ path: filePath })
    } catch (error) {
      console.error('Error in audio protocol:', error)
      return callback({ error: -2 /* FAILED */ })
    }
  })
}

// Update the loadIndex function to handle different FAISS implementations
// Update loadIndex function to use the correct methods
async function loadIndex(dimension) {
  try {
    const indexPath = getIndexPath();
    
    try {
      // Check if the index file exists
      await fsPromises.access(indexPath);
      console.log(`Found existing index file at: ${indexPath}`);
      
      // Use read method as shown in docs
      const loadedIndex = faiss.IndexFlatL2.read(indexPath);
      console.log(`Successfully loaded index with dimension: ${loadedIndex.getDimension()}`);
      console.log(`Total vectors in index: ${loadedIndex.ntotal()}`);
      return loadedIndex;
    } catch (error) {
      console.log(`No existing index file found or error reading it: ${error.message}`);
    }
    
    // Create a new index
    console.log(`Creating new index with dimension: ${dimension}`);
    return new faiss.IndexFlatL2(dimension);
  } catch (error) {
    console.error(`Error in loadIndex: ${error.message}`);
    console.log('Falling back to new index');
    return new faiss.IndexFlatL2(dimension);
  }
}

async function saveMetadata(metadata) {
  try {
    console.log(`Attempting to save metadata to: ${getMetadataPath()}`);
    const jsonString = JSON.stringify(metadata, null, 2);
    console.log(`Successfully serialized metadata, JSON length: ${jsonString.length} bytes`);
    
    try {
      // Create the directory if it doesn't exist
      await fsPromises.mkdir(path.dirname(getMetadataPath()), { recursive: true });
    } catch (dirError) {
      console.log(`Note: Directory creation result: ${dirError ? dirError.message : 'already exists'}`);
    }
    
    await fsPromises.writeFile(getMetadataPath(), jsonString);
    console.log(`Successfully wrote metadata file`);
    
    // Verify the file was written
    try {
      const stats = await fsPromises.stat(getMetadataPath());
      console.log(`Verified metadata file exists with size: ${stats.size} bytes`);
      return true;
    } catch (statError) {
      console.error(`Error verifying metadata file: ${statError.message}`);
      return false;
    }
  } catch (error) {
    console.error(`Error saving metadata: ${error.message}`);
    console.error(error.stack);
    return false;
  }
}

async function loadMetadata() {
  try {
    const data = await fsPromises.readFile(getMetadataPath(), 'utf-8')
    return JSON.parse(data)
  } catch (error) {
    // If no metadata exists, return empty array
    return []
  }
}

// Add an embedding to the index
// Update the addEmbedding function to use the working flat array approach
// Update addEmbedding function to match the docs
async function addEmbedding(embedding, metadata) {
  try {
    // Validate embedding
    if (!Array.isArray(embedding)) {
      throw new Error('Embedding must be an array');
    }
    
    const dimension = embedding.length;
    if (dimension <= 0) {
      throw new Error('Embedding array must have a positive length');
    }
    
    // Load or create index
    const index = await loadIndex(dimension);
    
    // Add the embedding (according to docs, just pass the array directly)
    console.log(`Adding embedding with dimension: ${dimension}`);
    index.add(embedding);
    console.log(`Total vectors in index after adding: ${index.ntotal()}`);
    
    // Load current metadata
    const metadataList = await loadMetadata();
    
    // Add new metadata
    metadataList.push(metadata);
    
    // Save updated index and metadata
    const indexSaved = await saveIndex(index);
    const metadataSaved = await saveMetadata(metadataList);
    
    console.log(`Index saved: ${indexSaved}, Metadata saved: ${metadataSaved}`);
    
    return metadataList.length - 1;
  } catch (error) {
    console.error('Error in addEmbedding:', error);
    throw error;
  }
}

// Update searchSimilar to use the flat array approach
async function searchSimilar(queryEmbedding, numResults = 10) {
  try {
    // Load index
    const index = await loadIndex(queryEmbedding.length);
    
    // Load metadata
    const metadataList = await loadMetadata();
    
    // Calculate how many results to return
    const count = Math.min(numResults, metadataList.length);
    
    if (count === 0) {
      return [];
    }
    
    // Use search according to docs
    console.log(`Searching for ${count} similar samples`);
    const results = index.search(queryEmbedding, count);
    
    console.log(`Search results:`, {
      numResults: results.labels.length,
      labels: results.labels,
      distances: results.distances
    });
    
    // Map results to metadata using the labels from search results
    return results.labels.map((idx, i) => ({
      similarity: 1 / (1 + results.distances[i]),
      metadata: metadataList[idx]
    }));
  } catch (error) {
    console.error('Error searching for similar samples:', error);
    return [];
  }
}

// Use Float32Array for better compatibility with FAISS
function generateEmbedding(filePath) {
  const dimensions = 128;
  // Create a Float32Array instead of a regular JavaScript array
  const embedding = new Float32Array(dimensions);
  
  // Fill with random values
  for (let i = 0; i < dimensions; i++) {
    embedding[i] = Math.random();
  }
  
  // Return as a regular array for easier handling
  return Array.from(embedding);
}


function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Add this to src/main/index.ts, inside app.whenReady().then() callback
  // Handle folder selection
  ipcMain.handle('select-samples-directory', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Samples Folder'
    })
    
    if (!result.canceled) {
      return result.filePaths[0]
    }
    return null
  })

  // Handle scanning for audio files
  ipcMain.handle('scan-samples', async (_, directoryPath) => {
    try {
      const audioExtensions = ['.wav', '.mp3', '.aiff', '.flac', '.ogg']
      const files = await scanDirectory(directoryPath, audioExtensions)
      return files
    } catch (error) {
      console.error('Error scanning for samples:', error)
      return []
    }
  })

  // Update your scanDirectory function
  async function scanDirectory(directory, extensions) {
    let results = []
    
    try {
      const items = await fsPromises.readdir(directory, { withFileTypes: true })
      
      for (const item of items) {
        const fullPath = path.join(directory, item.name)
        
        if (item.isDirectory()) {
          // Recursively scan subdirectories
          const subResults = await scanDirectory(fullPath, extensions)
          results = results.concat(subResults)
        } else {
          // Check if file has an audio extension
          const ext = path.extname(item.name).toLowerCase()
          if (extensions.includes(ext)) {
            // New code to get audio metadata
            let duration = "0:30"; // Default fallback
            
            try {
              // Parse audio metadata
              const metadata = await mm.parseFile(fullPath);
              
              // Get duration in seconds
              const durationSec = metadata.format.duration || 0;
              
              // Format as MM:SS
              const minutes = Math.floor(durationSec / 60);
              const seconds = Math.floor(durationSec % 60);
              duration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
            } catch (metadataError) {
              console.error(`Error getting metadata for ${fullPath}:`, metadataError)
            }
            
            results.push({
              name: item.name,
              path: fullPath,
              directory: directory,
              extension: ext,
              duration: duration // Add duration to the results
            })
          }
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${directory}:`, error)
    }
    
    return results
  }

  ipcMain.handle('generate-embedding', async (_, filePath) => {
    try {
      const embedding = generateEmbedding(filePath)
      
      const metadata = {
        path: filePath,
        filename: path.basename(filePath),
        directory: path.dirname(filePath),
        extension: path.extname(filePath),
        timestamp: new Date().toISOString()
      }
      
      const idx = await addEmbedding(embedding, metadata)
      return idx !== -1
    } catch (error) {
      console.error('Error generating embedding:', error)
      return false
    }
  })

  ipcMain.handle('get-all-embeddings', async () => {
    try {
      // Load metadata which contains all the sample information
      const metadataList = await loadMetadata()
      
      return {
        count: metadataList.length,
        embeddings: metadataList
      }
    } catch (error) {
      console.error('Error getting all embeddings:', error)
      return {
        count: 0,
        embeddings: []
      }
    }
  })

  ipcMain.handle('generate-embeddings-batch', async (_, samples) => {
    try {
      let processedCount = 0
      const results = []
      
      // Process in smaller batches to avoid UI freezing
      const batchSize = 20
      for (let i = 0; i < samples.length; i += batchSize) {
        const batch = samples.slice(i, i + batchSize)
        
        for (const sample of batch) {
          const embedding = generateEmbedding(sample.path)
          
          const metadata = {
            path: sample.path,
            filename: sample.name,
            directory: sample.directory,
            extension: sample.extension,
            duration: sample.duration, // Include the duration
            timestamp: new Date().toISOString()
          }
          
          const idx = await addEmbedding(embedding, metadata)
          results.push(idx !== -1)
          processedCount++
        }
        
        // Logging progress
        console.log(`Processed ${processedCount}/${samples.length} samples`)
      }
      
      return results.every(r => r === true)
    } catch (error) {
      console.error('Error generating embeddings batch:', error)
      return false
    }
  })

  ipcMain.handle('find-similar-samples', async (_, samplePath) => {
    try {
      const queryEmbedding = generateEmbedding(samplePath)
      const similarSamples = await searchSimilar(queryEmbedding, 20)
      return similarSamples
    } catch (error) {
      console.error('Error finding similar samples:', error)
      return []
    }
  })

  ipcMain.handle('get-embedding-stats', async () => {
    try {
      // Check if files exist
      let hasIndex = false
      let count = 0
      
      try {
        await fsPromises.access(getIndexPath())
        hasIndex = true
      } catch {
        // Index file doesn't exist
      }
      
      try {
        const metadata = await loadMetadata()
        count = metadata.length
      } catch {
        // Metadata file doesn't exist
      }
      
      return { count, hasIndex }
    } catch (error) {
      console.error('Error getting embedding stats:', error)
      return { count: 0, hasIndex: false }
    }
  })

  ipcMain.handle('clear-embeddings', async () => {
    try {
      try {
        await fsPromises.unlink(getIndexPath())
      } catch {}
      
      try {
        await fsPromises.unlink(getMetadataPath())
      } catch {}
      
      return true
    } catch (error) {
      console.error('Error clearing embeddings:', error)
      return false
    }
  })

  ipcMain.handle('get-storage-path', () => {
    return app.getPath('userData')
  })

  ipcMain.handle('debug-file-system', async () => {
    await debugFileSystem();
    return "Debugging complete, check console logs";
  })

  // Handle the getAudioUrl IPC call
  // Handle the getAudioUrl IPC call
  ipcMain.handle('get-audio-url', (event, filePath) => {
    // Make sure the file exists
    try {
      if (fs.existsSync(filePath)) {
        // Return a URL using our custom protocol
        return `audio://${encodeURIComponent(filePath)}`
      } else {
        console.error(`File does not exist: ${filePath}`)
        throw new Error(`File does not exist: ${filePath}`)
      }
    } catch (error) {
      console.error('Error accessing audio file:', error)
      throw new Error(`Could not access audio file: ${filePath}`)
    }
  })

  // Handle play audio request
ipcMain.handle('play-audio', async (event, filePath) => {
  try {
    // Check if the file exists using fsPromises instead of fsPromises.promises
    if (fs.existsSync(filePath)) {
      console.log('File exists, attempting to play:', filePath)
      
      // Play using the system's default audio player
      sound.play(filePath)
      // shell.openPath(filePath)
      return { success: true, method: 'external' }
    } else {
      console.error('File does not exist:', filePath)
      return { success: false, error: 'File not found' }
    }
  } catch (error) {
    console.error('Error playing audio:', error)
    return { success: false, error: error.message }
  }
})

// Handle stop audio request (not much we can do with system player)
ipcMain.handle('stop-audio', async (event) => {
  return { success: true }
})

// Helper method to check if a file exists
ipcMain.handle('check-file-exists', async (event, filePath) => {
  try {
    return fs.existsSync(filePath)
  } catch (error) {
    console.error('Error checking if file exists:', error)
    return false
  }
})

})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

