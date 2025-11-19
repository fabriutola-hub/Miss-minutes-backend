const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

// 🔥 1. ACTIVAR CARPETA PÚBLICA (Con ruta absoluta para Render)
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

// 📍 LEER ARCHIVO GEOJSON (EXPEDIENTES TVA)
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

// 🖼️ PREPARAR IMAGEN (Backend Logic)
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

// 🗺️ FORMATO DE DATOS PARA LA IA (Ocultamos URL para que no la escriba)
function formatGeoJsonForChatbot(geoJson) {
  if (!geoJson || !geoJson.features) return '';
  
  let formatted = '\n\n=== 📁 EXPEDIENTE TVA-782: EVENTO MUELA DEL DIABLO ===\n\n';
  formatted += `ESTADO: ACTIVO | REGISTROS: ${geoJson.features.length}\n\n`;
  
  geoJson.features.forEach((feature, index) => {
    const props = feature.properties || {};
    
    formatted += `REGISTRO #${index + 1}: ${props.LUGAR}\n`;
    if (props.descripcion) {
      formatted += `   ℹ️ DATOS: ${props.descripcion}\n`;
    }
    
    // Le decimos que hay foto, pero NO le damos la ruta.
    if (props.imagenUrl) {
      formatted += `   📸 EVIDENCIA VISUAL: DISPONIBLE EN ARCHIVO (Menciona este lugar para mostrarla)\n`;
    }
    
    formatted += '\n';
  });
  
  formatted += '⚠️ PROTOCOLO DE ASISTENCIA:\n';
  formatted += '- Si la Variante pregunta por un lugar, describe los datos del registro.\n';
  formatted += '- IMPORTANTE: Nunca escribas rutas de archivos o URLs. El sistema mostrará la foto automáticamente si mencionas el nombre del lugar.\n\n';
  
  return formatted;
}

// 🔥 PERSONALIDAD: MISS MINUTES
const CHATBOT_PERSONALITY = `Eres "Miss Minutes", la IA de la AVT.

PERSONALIDAD:
- Tono: Alegre, sureña (estilo retro), eficiente, burocrática.
- Frases: "Cielos", "Variante", "Por todos los tiempos, siempre".

MISIÓN:
- Guiar a la variante en La Muela del Diablo usando los Expedientes.

ESTILO DE RESPUESTA:
- Conversacional y útil.
- Si hay evidencia visual disponible para un lugar, di algo como "Aquí tienes la evidencia visual de los archivos" o "Mira lo que encontré en el expediente", pero NO intentes generar la imagen tú misma ni escribas rutas.`;

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
    const PORT = process.env.PORT || 5000;

    // 🔥 2. DETECTAR URL BASE AUTOMÁTICAMENTE
    const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    console.log(`📩 [VARIANTE ${sessionId.substring(0,5)}]: "${message}"`);

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Solicitud vacía detectada' });
    }

    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash',
      generationConfig: { temperature: 0.85, maxOutputTokens: 800 }
    });

    if (!conversationHistories.has(sessionId)) conversationHistories.set(sessionId, []);
    const history = conversationHistories.get(sessionId);

    let fullPrompt = CHATBOT_PERSONALITY;
    if (geoJsonData) fullPrompt += formatGeoJsonForChatbot(geoJsonData);
    
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

    // (Lógica de Visión omitida, se mantiene igual)

    console.log('🟠 Consultando al Procesador Central...');

    const result = await model.generateContent(contentParts);
    const response = await result.response;
    let botResponse = response.text();

    if (!botResponse) botResponse = 'Interferencia temporal. Repite, dulzura.';

    // 📸 3. LÓGICA DE IMÁGENES INTELIGENTE (MATCH PARCIAL)
    const imagesInResponse = [];
    if (geoJsonData && !useVision) { 
      geoJsonData.features.forEach(feature => {
        const lugar = feature.properties.LUGAR; // Ej: "Cima Muela del Diablo"
        const imagenUrl = feature.properties.imagenUrl;
        
        if (imagenUrl) {
          // a) Dividimos el nombre del lugar en palabras clave (ignorando cortas)
          // Ej: "Cima", "Muela", "Diablo"
          const palabrasClave = lugar.toLowerCase().split(' ').filter(p => p.length > 3);
          const respuestaBotLower = botResponse.toLowerCase();

          // b) Verificamos si ALGUNA palabra clave está en la respuesta del bot
          const mencionado = palabrasClave.some(palabra => respuestaBotLower.includes(palabra));
          const coincidenciaExacta = respuestaBotLower.includes(lugar.toLowerCase());

          if (mencionado || coincidenciaExacta) {
            console.log(`📸 Foto detectada para envío: ${lugar}`);
            
            // 🔥 c) FIX DE ESPACIOS Y URL COMPLETA
            imagesInResponse.push({
              lugar: lugar,
              url: `${BASE_URL}${encodeURI(imagenUrl)}`, 
              descripcion: feature.properties.descripcion,
              coordenadas: feature.geometry.coordinates
            });
          }
        }
      });
    }

    history.push({ role: 'Variante', content: message });
    history.push({ role: 'Miss Minutes', content: botResponse });

    if (history.length > 16) history.splice(0, history.length - 16);

    console.log(`✅ Respuesta enviada (${botResponse.length} chars) + ${imagesInResponse.length} archivos`);

    res.json({ 
      response: botResponse,
      images: imagesInResponse.length > 0 ? imagesInResponse : undefined,
      analyzedImages: includedImages.length > 0 ? includedImages : undefined
    });

  } catch (error) {
    console.error('❌ Error Crítico:', error.message);
    res.status(500).json({ error: 'Error en la Línea Temporal' });
  }
});

// 🗺️ ENDPOINTS EXTRA
app.get('/api/geojson', (req, res) => geoJsonData ? res.json(geoJsonData) : res.status(404).send('No data'));
app.post('/api/reset', (req, res) => { conversationHistories.delete(req.body.sessionId); res.json({msg:'Pruned'}); });
app.get('/api/lugar/:nombre', (req, res) => {
  const lugar = geoJsonData?.features.find(f => f.properties.LUGAR.toLowerCase().includes(req.params.nombre.toLowerCase()));
  lugar ? res.json(lugar) : res.status(404).json({error: 'Not found'});
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🕒 MISS MINUTES ONLINE - PORT ${PORT}`));
