const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

// Servir archivos estáticos (imágenes) si están en la carpeta public del backend
// Esto asegura que la URL funcione si las imágenes viven en el servidor
app.use(express.static(path.join(__dirname, 'public'))); 

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174'],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
  console.error('❌ ERROR CRÍTICO: Llave de acceso al Mainframe (GEMINI_API_KEY) no encontrada.');
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 📍 LEER ARCHIVO GEOJSON
let geoJsonData = null;
const geoJsonPath = path.join(__dirname, 'data', 'puntos_muela.geojson');

console.log(`🔍 Escaneando Archivos de la Línea Temporal en: ${geoJsonPath}`);

try {
  if (!fs.existsSync(geoJsonPath)) {
    console.error('❌ Expediente perdido:', geoJsonPath);
  } else {
    const rawData = fs.readFileSync(geoJsonPath, 'utf8');
    geoJsonData = JSON.parse(rawData);
    console.log(`✅ Archivos TVA cargados: ${geoJsonData.features?.length || 0} registros temporales recuperados.\n`);
  }
} catch (error) {
  console.error('❌ Corrupción de datos:', error.message);
}

// 🖼️ FUNCIONES DE IMAGEN (Se mantienen igual)
function imageToBase64(imagePath) {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    return imageBuffer.toString('base64');
  } catch (error) {
    console.error(`Error leyendo evidencia visual: ${imagePath}`, error.message);
    return null;
  }
}

function prepareImageForGemini(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  let mimeType = 'image/jpeg';
  if (ext === '.png') mimeType = 'image/png';
  else if (ext === '.webp') mimeType = 'image/webp';
  else if (ext === '.gif') mimeType = 'image/gif';
  
  const base64Data = imageToBase64(imagePath);
  if (!base64Data) return null;
  return { inlineData: { data: base64Data, mimeType: mimeType } };
}

// 🔥 CORRECCIÓN AQUÍ: OCULTAMOS LA URL A LA IA
function formatGeoJsonForChatbot(geoJson) {
  if (!geoJson || !geoJson.features) return '';
  
  let formatted = '\n\n=== 📁 EXPEDIENTE TVA-782: EVENTO MUELA DEL DIABLO ===\n\n';
  formatted += `ESTADO: ACTIVO | REGISTROS: ${geoJson.features.length}\n\n`;
  
  geoJson.features.forEach((feature, index) => {
    const props = feature.properties || {};
    const coords = feature.geometry?.coordinates || [];
    
    formatted += `REGISTRO #${index + 1}: ${props.LUGAR}\n`;
    
    if (coords.length >= 2) {
      formatted += `   📍 COORDENADAS: Lat ${coords[1].toFixed(6)}°, Lng ${coords[0].toFixed(6)}°\n`;
    }
    
    if (props.descripcion) {
      formatted += `   ℹ️ DATOS: ${props.descripcion}\n`;
    }
    
    // 🔥 AQUÍ ESTÁ EL CAMBIO IMPORTANTE:
    // Le decimos que SÍ hay foto, pero NO le damos la URL para que no la escriba.
    if (props.imagenUrl) {
      formatted += `   📸 EVIDENCIA VISUAL: DISPONIBLE EN ARCHIVO (El sistema la adjuntará automáticamente si mencionas este lugar)\n`;
    }
    
    formatted += '\n';
  });
  
  formatted += '⚠️ PROTOCOLO DE ASISTENCIA:\n';
  formatted += '- Si la Variante pregunta por un lugar, describe los datos del registro.\n';
  formatted += '- IMPORTANTE: NUNCA escribas rutas de archivos (ej: /imagenes/...). El sistema se encarga de mostrar la foto.\n';
  formatted += '- Simplemente di: "Aquí tienes una imagen de los archivos" o similar.\n\n';
  
  return formatted;
}

const CHATBOT_PERSONALITY = `Eres "Miss Minutes", la IA de la AVT.

PERSONALIDAD:
- Tono: Alegre, sureña, eficiente, burocrática.
- Frases: "Cielos", "Variante", "Por todos los tiempos".

MISIÓN:
- Guiar a la variante en la Muela del Diablo usando los Expedientes.

ESTILO DE RESPUESTA:
- Conversacional y útil.
- NUNCA inventes rutas de imágenes. Solo menciona que la evidencia visual está disponible.`;

const conversationHistories = new Map();

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'TVA System: ONLINE',
    geoJsonLoaded: !!geoJsonData,
    recordsCount: geoJsonData?.features?.length || 0
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId = 'default', useVision = false } = req.body;
    
    console.log(`📩 [VARIANTE ${sessionId.substring(0,5)}]: "${message}"`);

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Solicitud vacía' });
    }

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.85, maxOutputTokens: 800 }
    });

    if (!conversationHistories.has(sessionId)) {
      conversationHistories.set(sessionId, []);
    }

    const history = conversationHistories.get(sessionId);
    let fullPrompt = CHATBOT_PERSONALITY;
    
    if (geoJsonData) {
      fullPrompt += formatGeoJsonForChatbot(geoJsonData);
    }
    
    if (history.length > 0) {
      fullPrompt += 'REGISTRO PREVIO:\n';
      history.slice(-4).forEach(msg => {
        fullPrompt += `${msg.role}: ${msg.content}\n`;
      });
      fullPrompt += '\n';
    }

    fullPrompt += `Variante: ${message}\n\nMiss Minutes:`;

    let contentParts = [fullPrompt];
    let includedImages = [];

    // (Lógica de Visión omitida por brevedad, se mantiene igual)

    const result = await model.generateContent(contentParts);
    const response = await result.response;
    let botResponse = response.text();

    if (!botResponse) botResponse = 'Interferencia temporal. Repite, dulzura.';

    // 📸 LÓGICA DE ADJUNTAR IMÁGENES (Esto es lo que hace que la imagen aparezca)
    const imagesInResponse = [];
    if (geoJsonData && !useVision) { 
      geoJsonData.features.forEach(feature => {
        const lugar = feature.properties.LUGAR;
        const imagenUrl = feature.properties.imagenUrl;
        
        // Si el bot menciona el NOMBRE del lugar, el sistema adjunta la foto invisiblemente
        if (imagenUrl && botResponse.toLowerCase().includes(lugar.toLowerCase())) {
          imagesInResponse.push({
            lugar: lugar,
            url: imagenUrl, // Aquí enviamos la URL real al frontend
            descripcion: feature.properties.descripcion,
            coordenadas: feature.geometry.coordinates
          });
        }
      });
    }

    history.push({ role: 'Variante', content: message });
    history.push({ role: 'Miss Minutes', content: botResponse });

    if (history.length > 16) history.splice(0, history.length - 16);

    res.json({ 
      response: botResponse,
      images: imagesInResponse.length > 0 ? imagesInResponse : undefined
    });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: 'Error en la Línea Temporal' });
  }
});

// (Resto de endpoints igual...)
app.get('/api/geojson', (req, res) => geoJsonData ? res.json(geoJsonData) : res.status(404).send('No data'));
app.post('/api/reset', (req, res) => { conversationHistories.delete(req.body.sessionId); res.json({msg:'Pruned'}); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🕒 MISS MINUTES ONLINE - PORT ${PORT}`));
